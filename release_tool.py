#!/usr/bin/env python3
"""Build/verify local release assets; publishing requires two explicit approvals."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

PLUGIN = "zcode-token-usage-statusbar"
PREFIX = f"plugins/{PLUGIN}/"
PLUGIN_ID = f"{PLUGIN}@zusage-marketplace"
SEMVER = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
MAX_FILE = 8 * 1024 * 1024
MAX_ASSET = 16 * 1024 * 1024
MAX_MANIFEST = 256 * 1024
MAX_TOTAL = 64 * 1024 * 1024
SYNC_FILES = ("usage_mcp.py", "zusage.py", "patch_install.py", "install_monitor.py",
              "inject-main.cjs", "plugin-updater.cjs", "runtime_lock.py", "usage_stats.py", "turn-stats.js", "overlay.js",
              "plugin-release.cjs", "plugin-storage.cjs", "quota-client.cjs", "model-puller.cjs", "release_unpack.py", "token_rate.py", "renderer_bridge.py")
# Enumerated source paths, never a recursive glob that could collect local usage data.
SOURCES = (*SYNC_FILES, "overlay_install.py", "plugin_auto_update.py",
           "restart_notice.py", ".mcp.json", "README.md", ".zcode-plugin/plugin.json",
           ".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/session-start.py",
           "hooks/prompt-submit.py", "commands/usage.md", "commands/install-overlay.md",
           "commands/uninstall-overlay.md", "skills/zcode-token-usage/SKILL.md")
NAMES = tuple(sorted(("LICENSE", "marketplace.json", *(PREFIX + p for p in SOURCES))))
RELEVANT = ("LICENSE", "marketplace.json", "plugins", "release_tool.py", "sync_plugin.py", *SYNC_FILES)


class ReleaseError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def repository(value):
    require(isinstance(value, str) and re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._-]*", value),
        "repository must be explicit owner/repo (GitHub only)")
    return value


def read_file(path, limit=MAX_FILE):
    require(not path.is_symlink() and path.is_file(), f"not a regular source file: {path}")
    require(path.stat().st_size <= limit, f"oversize file: {path}")
    return path.read_bytes()


def identities(data, expected=None):
    market = json.loads(data["marketplace.json"])
    manifest = json.loads(data[PREFIX + ".zcode-plugin/plugin.json"])
    compatibility = json.loads(data[PREFIX + ".claude-plugin/plugin.json"])
    require(all(isinstance(value, dict) for value in (market, manifest, compatibility)),
            "project manifests must be JSON objects")
    version = manifest.get("version")
    require(isinstance(version, str) and re.fullmatch(SEMVER, version), "stable SEMVER required")
    require(manifest == compatibility and manifest.get("name") == PLUGIN,
            "plugin manifests/name disagree")
    require(market.get("name") == "zusage-marketplace", "marketplace name disagrees")
    entries = market.get("plugins", [])
    require(isinstance(entries, list) and len(entries) == 1, "unexpected marketplace plugins")
    entry = entries[0]
    require(isinstance(entry, dict), "marketplace entry must be an object")
    require(entry.get("name") == PLUGIN and entry.get("version") == version and
            entry.get("source") == "./plugins/" + PLUGIN, "marketplace version/name/source disagrees")
    require(manifest.get("commands") == "commands" and manifest.get("skills") == "skills",
            "plugin component paths disagree")
    require(expected is None or expected == version, "requested version disagrees")
    return version


def require_layout(data):
    # Older in-the-field unpackers (<= v1.4.5) treat a ZIP without a declared
    # layout as "must exactly match my own historical file set"; any added or
    # removed file then fails the update with "ZIP is missing required release
    # files". Both plugin manifests must therefore always declare the full ZIP
    # file set, kept in lockstep with NAMES.
    manifest = json.loads(data[PREFIX + ".zcode-plugin/plugin.json"])
    layout = manifest.get("packageLayout")
    require(isinstance(layout, dict) and type(layout.get("schemaVersion")) is int and
            layout["schemaVersion"] == 1 and isinstance(layout.get("files"), list) and
            all(isinstance(name, str) for name in layout["files"]) and
            len(layout["files"]) == len(set(layout["files"])) and
            set(layout["files"]) == set(NAMES),
            "plugin manifest packageLayout disagrees with packaged files; declare the full ZIP "
            "file set in both plugin manifests (see .zcode/skills/zcode-github-release/references/release-contract.md)")


def source_data(root, expected=None):
    plugin = root / "plugins" / PLUGIN
    require(plugin.is_dir() and not plugin.is_symlink() and not (root / "plugins").is_symlink(),
            "missing or symlink plugin source directory")
    for directory, dirs, files in os.walk(plugin, followlinks=False):
        for name in dirs + files:
            require(not (Path(directory) / name).is_symlink(), "symlink in plugin tree")
    data = {name: read_file(root / name) for name in NAMES}
    require(sum(map(len, data.values())) <= MAX_TOTAL, "oversize source tree")
    identities(data, expected)
    require_layout(data)
    for name in SYNC_FILES:
        require(read_file(root / name) == data[PREFIX + name], f"runtime copy drift: {name}")
    return data


def zip_name(version):
    return f"{PLUGIN}-v{version}.zip"


def build(root, repo, out, version=None):
    repo = repository(repo)
    data = source_data(root, version)
    version = identities(data, version)
    require(not out.exists() and not out.is_symlink(), "output directory already exists")
    out.mkdir(parents=True, exist_ok=False)
    asset = out / zip_name(version)
    with zipfile.ZipFile(asset, "x", compression=zipfile.ZIP_STORED) as archive:
        for name in NAMES:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, data[name])
    payload = read_file(asset, MAX_ASSET)
    manifest = {"schemaVersion": 1, "repository": repo, "version": version, "tag": "v" + version,
                "pluginId": PLUGIN_ID, "asset": {"name": asset.name, "size": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest()}}
    path = out / "release-manifest.json"
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    verify(asset, path, repo)
    catalog = json.loads(data["marketplace.json"])
    catalog["plugins"][0]["source"] = {
        "source": "url", "type": "zip", "url":
        f"https://github.com/{repo}/releases/download/v{version}/{asset.name}",
        "sha256": manifest["asset"]["sha256"], "path": "plugins/" + PLUGIN, "stripRoot": False}
    catalog_path = out / "marketplace-release.json"
    catalog_path.write_text(json.dumps(catalog, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {"zip": str(asset.resolve()), "manifest": str(path.resolve()),
            "catalog": str(catalog_path.resolve()), **manifest}


def verify(asset, manifest_path, repo=None):
    require(asset.name != manifest_path.name and manifest_path.name == "release-manifest.json",
            "expected separate release-manifest.json")
    manifest = json.loads(read_file(manifest_path, MAX_MANIFEST))
    require(isinstance(manifest, dict), "release manifest must be a JSON object")
    repository(manifest.get("repository"))
    require(repo is None or repository(repo) == manifest["repository"], "repository disagrees")
    version = manifest.get("version")
    require(isinstance(version, str) and re.fullmatch(SEMVER, version), "stable SEMVER required")
    require(type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == 1 and
            manifest.get("tag") == "v" + version and manifest.get("pluginId") == PLUGIN_ID,
            "release manifest identity disagrees")
    record = manifest.get("asset", {})
    require(isinstance(record, dict), "asset record must be a JSON object")
    payload = read_file(asset, MAX_ASSET)
    require(asset.name == record.get("name") == zip_name(version) and
            type(record.get("size")) is int and record["size"] == len(payload) and
            record.get("sha256") == hashlib.sha256(payload).hexdigest(), "asset name/size/hash disagrees")
    # Check bounded compression/resources before our ZIP reads; never import ZIP code.
    helper_path = Path(__file__).resolve().with_name("release_unpack.py")
    read_file(helper_path)
    spec = importlib.util.spec_from_file_location("release_tool_unpack", helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    with tempfile.TemporaryDirectory(prefix="zusage-release-verify-") as temporary:
        try:
            helper.unpack(asset.absolute(), manifest_path.absolute(), manifest["repository"], version,
                          Path(temporary) / "marketplace")
        except (ValueError, OSError, TypeError, RuntimeError, EOFError, RecursionError,
                zipfile.BadZipFile, zipfile.LargeZipFile, helper.zlib.error) as error:
            raise ReleaseError(f"release unpack validation failed: {error}") from error
    with zipfile.ZipFile(asset) as archive:
        members = archive.infolist()
        require(len(members) == len(NAMES), "unexpected ZIP entries or duplicate names")
        data = {}
        total = 0
        for member in members:
            name = member.filename
            path = PurePosixPath(name)
            mode = member.external_attr >> 16
            require(name in NAMES and not path.is_absolute() and ".." not in path.parts and
                    "\\" not in name and ":" not in name and name not in data,
                    f"unsafe or non-source ZIP entry: {name}")
            require(not member.is_dir() and stat.S_IFMT(mode) in (0, stat.S_IFREG) and
                    not member.flag_bits & 1 and member.compress_type in
                    (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "non-regular/encrypted/unsupported ZIP entry")
            total += member.file_size
            require(member.file_size <= MAX_FILE and total <= MAX_TOTAL, "oversize ZIP contents")
            data[name] = archive.read(member)
        require(set(data) == set(NAMES), "missing ZIP source")
        identities(data, version)
        require_layout(data)
    return manifest


def run(root, *args):
    result = subprocess.run(args, cwd=root, capture_output=True, check=False)
    require(result.returncode == 0, f"command failed: {' '.join(args)}\n" +
            result.stderr.decode("utf-8", errors="replace"))
    return result.stdout


def gh_json(root, endpoint, *flags):
    return json.loads(run(root, "gh", "api", endpoint, "--hostname", "github.com",
                          "--method", "GET", *flags))


GITCODE_API = "https://api.gitcode.com/api/v5"
# Asset hosts the updater may download GitCode release files from. Verified on the
# first real mirror upload; extend only together with plugin-release.cjs fetchBytes.
GITCODE_ASSET_HOSTS = ("gitcode.com", "raw.gitcode.com")


def gitcode_repository(value):
    require(isinstance(value, str) and re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._-]*", value),
        "--gitcode-repo must be explicit owner/repo")
    return value


def gitcode_api(path, token=None, query=None, method="GET", body=None, headers=None, timeout=120):
    # Returns (status, body) for every HTTP outcome so callers can branch on 404;
    # never surface full URLs on failure: the access_token rides in the query string.
    params = dict(query or {})
    if token:
        params["access_token"] = token
    url = GITCODE_API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        with error:
            return error.code, error.read()
    except (urllib.error.URLError, OSError, TimeoutError) as error:
        detail = error.reason if isinstance(error, urllib.error.URLError) else error
        raise ReleaseError(f"gitcode api {method} {path} failed: {detail}") from None


class _TraceRedirects(urllib.request.HTTPRedirectHandler):
    # Record every redirect hop so the observed host chain can be pinned in
    # plugin-release.cjs fetchBytes; never log query strings (may carry tokens).
    def __init__(self, hops):
        self.hops = hops

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.hops.append(urllib.parse.urlsplit(newurl)._replace(query=None).geturl())
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_traced(url, hops, timeout=120):
    opener = urllib.request.build_opener(_TraceRedirects(hops))
    request = urllib.request.Request(url, headers={"User-Agent": "zusage-release-tool"})
    with opener.open(request, timeout=timeout) as response:
        # 有界下载（输入侧 read_file 的 MAX_ASSET 同款上限）：异常大响应先按上限截断，
        # 后续 sha256 字节比对失败仍 fail-closed，但内存不被放大
        return response.read(MAX_ASSET + 1), response.geturl()


def preflight(root, repo, manifest, asset):
    data = source_data(root, manifest["version"])
    with zipfile.ZipFile(asset) as archive:
        require(all(archive.read(name) == content for name, content in data.items()),
                "ZIP is not the current repository source")
    top = run(root, "git", "rev-parse", "--show-toplevel").decode().strip()
    require(Path(top).resolve() == root.resolve(), "--root must be the git repository root")
    head = run(root, "git", "rev-parse", "--verify", "HEAD^{commit}").decode().strip()
    require(not run(root, "git", "status", "--porcelain", "--untracked-files=all", "--", *RELEVANT),
            "relevant git files are dirty or untracked")
    for name in NAMES:
        # 先比经 git 清洗过滤器（CRLF→LF 归一化）后的 blob OID，区分“内容未提交”；
        # 再要求逐字节一致：发布包取的是工作区字节，Windows 的 CRLF 检出会让同一 tag
        # 打出不同产物。.gitattributes 已固定 eol=lf，旧检出须按 maintaining.md 重新检出。
        oid = run(root, "git", "hash-object", "--", name).decode().strip()
        require(oid == run(root, "git", "rev-parse", f"HEAD:{name}").decode().strip(),
                "source not committed in HEAD")
        require(run(root, "git", "cat-file", "blob", "HEAD:" + name) == data[name],
                f"line endings differ from HEAD: {name}; re-checkout with LF (see docs/maintaining.md)")
    remotes = run(root, "git", "remote", "-v").decode().splitlines()
    urls = [line.split()[1] for line in remotes if len(line.split()) >= 2]
    require(any(re.fullmatch(r"(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)" +
                             re.escape(repo) + r"(?:\.git)?/?", url, re.I) for url in urls),
            "explicit repository is not a configured GitHub remote")
    tag = manifest["tag"]
    require(run(root, "git", "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}").decode().strip()
            == head, "local tag does not point to HEAD")
    run(root, "gh", "auth", "status", "--hostname", "github.com")
    info = gh_json(root, f"repos/{repo}")
    require(info.get("full_name", "").lower() == repo.lower() and
            info.get("permissions", {}).get("push") is True, "no push permission for explicit repo")
    obj = gh_json(root, f"repos/{repo}/git/ref/tags/{tag}")["object"]
    for _ in range(4):
        if obj.get("type") == "commit":
            break
        require(obj.get("type") == "tag" and re.fullmatch(r"[0-9a-f]{40}", obj.get("sha", "")),
                "invalid remote tag")
        obj = gh_json(root, f"repos/{repo}/git/tags/{obj['sha']}")["object"]
    require(obj.get("type") == "commit" and obj.get("sha") == head, "remote tag does not point to HEAD")
    pages = gh_json(root, f"repos/{repo}/releases?per_page=100", "--paginate", "--slurp")
    require(isinstance(pages, list) and all(isinstance(page, list) for page in pages),
            "unexpected GitHub release listing")
    require(not any(release.get("tag_name") == tag for page in pages for release in page),
            "release already exists (including drafts); refusing overwrite")
    return head


def gitcode_mirror(asset, manifest_path, manifest, notes, tag, gitcode_repo, out_dir):
    # Mirrors an already-verified GitHub release to GitCode and derives the GitCode
    # channel catalog from the observed asset URLs. Runs only after --publish won.
    token = (os.environ.get("GITCODE_TOKEN") or "").strip()
    require(token, "GITCODE_TOKEN is required for --gitcode-repo")
    version = manifest["version"]

    def asset_bytes(path):
        return read_file(path, MAX_ASSET if path.suffix == ".zip" else MAX_MANIFEST)

    status, payload = gitcode_api(f"/repos/{gitcode_repo}/releases/tags/{tag}")
    if status == 200:
        release = json.loads(payload)
        require(isinstance(release, dict) and release.get("tag_name") == tag,
                "existing GitCode release identity disagrees; refusing to reuse")
    else:
        require(status == 404, f"gitcode release lookup -> HTTP {status}")
        body = json.dumps({"tag_name": tag, "name": tag, "body": notes}).encode("utf-8")
        status, payload = gitcode_api(f"/repos/{gitcode_repo}/releases", token=token, method="POST",
                                      body=body, headers={"Content-Type": "application/json"})
        require(status in (200, 201), f"gitcode release create -> HTTP {status}")
        release = json.loads(payload)
        require(isinstance(release, dict) and release.get("tag_name") == tag,
                "gitcode release tag disagrees after create")

    for path in (asset, manifest_path):
        status, payload = gitcode_api(f"/repos/{gitcode_repo}/releases/{tag}/upload_url", token=token,
                                      query={"file_name": path.name})
        require(status == 200, f"gitcode upload_url for {path.name} -> HTTP {status}")
        ticket = json.loads(payload)
        url, headers = ticket.get("url"), ticket.get("headers") or {}
        require(isinstance(url, str) and url.startswith("https://") and isinstance(headers, dict),
                "gitcode upload ticket disagrees")
        request = urllib.request.Request(url, data=asset_bytes(path), method="PUT",
                                         headers={str(key): str(value) for key, value in headers.items()})
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                require(200 <= response.status < 300, f"gitcode asset upload -> HTTP {response.status}")
        except urllib.error.HTTPError as error:
            error.close()
            raise ReleaseError(f"gitcode asset upload for {path.name} -> HTTP {error.code}") from None
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            detail = error.reason if isinstance(error, urllib.error.URLError) else error
            raise ReleaseError(f"gitcode asset upload for {path.name} failed: {detail}") from None

    status, payload = gitcode_api(f"/repos/{gitcode_repo}/releases/tags/{tag}")
    require(status == 200, f"gitcode release reread -> HTTP {status}")
    release = json.loads(payload)
    assets = release.get("assets") or []
    require(isinstance(assets, list), "gitcode release assets disagree")
    urls = {}
    for path in (asset, manifest_path):
        entry = next((a for a in assets if isinstance(a, dict) and a.get("name") == path.name), None)
        require(isinstance(entry, dict) and isinstance(entry.get("browser_download_url"), str),
                f"gitcode asset {path.name} missing after upload")
        urls[path.name] = entry["browser_download_url"]

    hops = []
    for path in (asset, manifest_path):
        url = urls[path.name]
        require(urllib.parse.urlsplit(url).hostname in GITCODE_ASSET_HOSTS,
                f"unexpected GitCode asset host for {path.name}; extend GITCODE_ASSET_HOSTS and "
                "plugin-release.cjs fetchBytes together after verifying the real URL")
        content, final = download_traced(url, hops)
        require(content == asset_bytes(path), f"gitcode asset {path.name} bytes disagree after upload")
        if path.suffix == ".zip":
            require(hashlib.sha256(content).hexdigest() == manifest["asset"]["sha256"],
                    "gitcode zip sha256 disagrees")
            zip_url = url

    with zipfile.ZipFile(asset) as archive:
        catalog = json.loads(archive.read("marketplace.json"))
    require(isinstance(catalog, dict) and isinstance(catalog.get("plugins"), list)
            and len(catalog["plugins"]) == 1, "marketplace catalog shape disagrees")
    catalog["plugins"][0]["source"] = {
        "source": "url", "type": "zip", "url": zip_url,
        "sha256": manifest["asset"]["sha256"], "path": "plugins/" + PLUGIN, "stripRoot": False}
    catalog_path = out_dir / "marketplace-release-gitcode.json"
    catalog_path.write_text(json.dumps(catalog, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {"zipUrl": zip_url, "manifestUrl": urls[manifest_path.name],
            "catalog": str(catalog_path.resolve()), "redirectHops": hops}


def publish(root, repo, asset, manifest_path, approved=False, confirm=None, notes_file=None,
            gitcode_repo=None):
    repo = repository(repo)
    if gitcode_repo is not None:
        gitcode_repo = gitcode_repository(gitcode_repo)
        if approved:
            require((os.environ.get("GITCODE_TOKEN") or "").strip(),
                    "GITCODE_TOKEN is required for --gitcode-repo")
    require(asset.name != manifest_path.name and manifest_path.name == "release-manifest.json",
            "expected separate release-manifest.json")
    asset_input, manifest_input = str(asset.resolve()), str(manifest_path.resolve())
    # Verify, upload and compare only owned snapshots, never mutable input assets.
    with tempfile.TemporaryDirectory(prefix="zusage-release-snapshot-") as temporary:
        directory = Path(temporary)
        asset_snapshot, manifest_snapshot = directory / asset.name, directory / manifest_path.name
        asset_snapshot.write_bytes(read_file(asset, MAX_ASSET))
        manifest_snapshot.write_bytes(read_file(manifest_path, MAX_MANIFEST))
        asset, manifest_path = asset_snapshot, manifest_snapshot
        manifest = verify(asset, manifest_path, repo)
        tag = manifest["tag"]
        require(not approved or confirm == f"{repo}/{tag}", "--publish requires --confirm owner/repo/vVERSION")
        require(notes_file is not None, "publish requires --notes-file")
        notes_file = Path(notes_file).absolute()
        notes = read_file(notes_file, MAX_MANIFEST).decode("utf-8")
        label = notes.strip().strip("#*_`").strip()
        if len(label.splitlines()) == 1:
            # Only unwrap inline link destinations for the placeholder check, not the notes.
            parts, start = [], 0
            for match in re.finditer(r"\[([^\[\]\r\n]+)\]\(", label):
                if match.start() < start:
                    continue
                end, depth, delimiter = match.end(), 1, None
                while end < len(label) and depth:
                    char = label[end]
                    if char == "\\":
                        end += 2
                        continue
                    if delimiter:
                        if char == delimiter:
                            delimiter = None
                    elif char == "<":
                        delimiter = ">"
                    elif char in "\"'" and label[end - 1].isspace():
                        delimiter = char
                    elif char == "(":
                        depth += 1
                    elif char == ")":
                        depth -= 1
                    end += 1
                if depth:
                    break  # Preserve the unclosed suffix; never rescan it for nested links.
                parts.extend((label[start:match.start()], match.group(1)))
                start = end
            label = ("".join(parts) + label[start:]).strip().strip("#*_`").strip()
        require(label and label.lower() not in (PLUGIN, "zusage-marketplace") and not re.fullmatch(
            rf"(?:(?:{re.escape(PLUGIN)}|zusage-marketplace|release)\s*[-:–—]?\s*)?v?"
            + re.escape(manifest["version"]), label, re.I), "release notes are empty or placeholder-only")
        head = preflight(root, repo, manifest, asset)
        commands = [
            ["gh", "release", "create", tag, "--repo", "github.com/" + repo, "--draft", "--verify-tag",
             "--target", head, "--title", tag, "--notes-file", str(notes_file)],
            ["gh", "release", "upload", tag, asset_input, manifest_input,
             "--repo", "github.com/" + repo],
            ["gh", "release", "edit", tag, "--repo", "github.com/" + repo, "--draft=false", "--verify-tag"],
        ]
        plan = {"dryRun": not approved, "repository": repo, "tag": tag, "commit": head,
                "zip": asset_input, "manifest": manifest_input, "commands": commands,
                "notesFile": str(notes_file), "notes": notes,
                "betweenUploadAndPublish": "verify draft identity, body and downloaded asset bytes"}
        if gitcode_repo is not None:
            plan["gitcode"] = {
                "repository": gitcode_repo, "tag": tag, "approved": approved,
                "steps": ["create or reuse release with the same tag and notes",
                          "upload the zip and release-manifest.json attachments",
                          "reread and byte-compare both assets",
                          f"write marketplace-release-gitcode.json next to {manifest_input}"]}
        if not approved:
            return plan
        # gh reads the owned notes snapshot, never the input file again after review.
        snapshot = directory / "release-notes.md"
        snapshot.write_bytes(notes.encode("utf-8"))
        run(root, *commands[0][:-1], str(snapshot))
        run(root, *commands[1][:4], str(asset), str(manifest_path), *commands[1][6:])
        pages = gh_json(root, f"repos/{repo}/releases?per_page=100", "--paginate", "--slurp")
        drafts = [r for page in pages for r in page if r.get("tag_name") == tag]
        require(len(drafts) == 1, "remote draft missing/ambiguous; left unpublished")
        draft = drafts[0]
        require(draft.get("draft") is True and draft.get("prerelease") is False and
                draft.get("tag_name") == tag, "remote draft identity disagrees; left unpublished")
        require(isinstance(draft.get("body"), str) and
                draft["body"].replace("\r\n", "\n").rstrip() == notes.replace("\r\n", "\n").rstrip(),
                "remote draft body disagrees; draft left unpublished")
        assets = draft.get("assets", [])
        require(len(assets) == 2 and {a.get("name") for a in assets} == {asset.name, manifest_path.name},
                "remote assets disagree; draft left unpublished")
        for path in (asset, manifest_path):
            entry = next(a for a in assets if a.get("name") == path.name)
            require(type(entry.get("id")) is int and entry.get("state") == "uploaded" and
                    entry.get("size") == path.stat().st_size, "remote asset metadata disagrees")
            content = run(root, "gh", "api", f"repos/{repo}/releases/assets/{entry['id']}", "--hostname",
                          "github.com", "--method", "GET", "--header", "Accept: application/octet-stream")
            require(content == read_file(path, MAX_TOTAL), "remote asset hash disagrees; draft left unpublished")
        # Fail closed if the remote tag changed while the draft was uploaded.
        remote = gh_json(root, f"repos/{repo}/commits/{tag}")
        require(remote.get("sha") == head, "remote tag changed; draft left unpublished")
        run(root, *commands[2])
        published = gh_json(root, f"repos/{repo}/releases/tags/{tag}")
        require(published.get("draft") is False and published.get("prerelease") is False and
                published.get("tag_name") == tag and sorted(
                    (a.get("id"), a.get("name"), a.get("size"), a.get("state"))
                    for a in published.get("assets", [])) == sorted(
                    (a.get("id"), a.get("name"), a.get("size"), a.get("state")) for a in assets),
                "published release state/assets disagree; inspect release manually")
        require(isinstance(published.get("body"), str) and
                published["body"].replace("\r\n", "\n").rstrip() == notes.replace("\r\n", "\n").rstrip(),
                "published release body disagrees; inspect release manually")
        if gitcode_repo is not None:
            plan["gitcode"].update(gitcode_mirror(
                asset, manifest_path, manifest, notes, tag, gitcode_repo,
                Path(manifest_input).parent))
        return plan


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("build", "verify", "publish"):
        p = sub.add_parser(command)
        p.add_argument("--root", type=Path, default=Path.cwd())
        p.add_argument("--repo", required=True)
        if command == "build":
            p.add_argument("--out", type=Path, required=True, help="new output directory (must not exist)")
            p.add_argument("--version")
        else:
            p.add_argument("--zip", dest="asset", type=Path, required=True)
            p.add_argument("--manifest", type=Path, required=True)
        if command == "publish":
            p.add_argument("--notes-file", type=Path, required=True, help="UTF-8 release notes (not a placeholder)")
            p.add_argument("--gitcode-repo", help="optional gitcode owner/repo; mirror the release "
                                                  "and emit marketplace-release-gitcode.json (needs GITCODE_TOKEN)")
            group = p.add_mutually_exclusive_group()
            group.add_argument("--publish", action="store_true")
            group.add_argument("--dry-run", action="store_true")
            p.add_argument("--confirm", help="exact owner/repo/vVERSION; required with --publish")
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            result = build(args.root.resolve(), args.repo, args.out, args.version)
        elif args.command == "verify":
            result = {"zip": str(args.asset.resolve()), "manifest": str(args.manifest.resolve()),
                      **verify(args.asset, args.manifest, args.repo)}
        else:
            result = publish(args.root.resolve(), args.repo, args.asset, args.manifest, args.publish, args.confirm,
                             notes_file=args.notes_file, gitcode_repo=args.gitcode_repo)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (ReleaseError, OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f"release_tool: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
