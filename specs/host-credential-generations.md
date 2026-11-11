# 宿主凭据代际与取钥

## 产品规则

- 内置套餐额度、ZCode Start Plan、重置卡与套餐源「拉取模型」都要用宿主 `credentials.json` 里的登录凭据。凭据值有三种形态：无前缀明文、`enc:v1:`、`enc:v2:`（宿主 3.18.0 起）；其它 `enc:*` 代际一律视为解不开。
- 解不开就是没有凭据：对应数据源按「未配置（解密失败）」降级，不发任何请求。任何情况下都不得把仍带 `enc:` 前缀的值当作 token 外发。
- `enc:v2:<os|env>:<keyId>:<payload>` 的密钥来源由条目自身声明：
  - `os`：密钥在 OS 凭据库（macOS Keychain / Windows 凭据管理器 / Linux secret-service）。插件主进程模块运行在宿主进程内，经宿主自带的 `@napi-rs/keyring` 读取（asar 内 wrapper 优先，unpacked 原生 `.node` 扫描兜底），与宿主自身的读取方式相同；不调用外部命令，不修改凭据库条目。
  - `env`：宿主 managed secret，来源序与宿主一致：`ZCODE_CREDENTIAL_SECRET`，其次 `ZCODE_CREDENTIAL_SECRET_FILE`（两者同时配置按不可用），最后是凭据同目录的 `credential-secret`（常规文件、非 win32 仅属主、32–4096 字节——宿主在无 os 标记时以它派生 env 源）。
- 取到的密钥必须与条目的 keyId 相符才用于解密。插件与宿主同款：受管 secret 可用即优先按 env 源取钥（不看信封声明），否则走 OS 凭据库；密钥与条目不符就解不开。桌面常驻下受管 secret 通常缺席，OS 凭据库是常态来源。
- 密钥只在内存，不落盘、不进日志与诊断。
- 宿主没有 keyring 依赖时（3.17.x 及更早，凭据仍是 `enc:v1`）行为与此前一致。

## 状态所有者与接口

- `quota-client.cjs`（分片 `src/quota/00-constants-and-crypto.cjs`）拥有全部解密逻辑。`decryptValue(value, key)` 是分发器：v2 信封路由到模块级 `defaultDec`，v1/明文维持原 `(value, key)` 语义——所有既有调用点无需感知 v2。`makeHostDecryptor(opts)` 创建独立解密器实例（`credsPath`/`credsDir`/`resourcesDir`/`env`/`readFileRaw`/`keyringMod` 注入），`setDefaultDecryptCtx(opts)` 绑定分发器用的缺省实例（客户端装配时以真实路径调用）。
- 客户端创建与每次 tick 异步预热密钥缓存（`ensureDefaultV2Key`，单飞 memoize）；解密同步读缓存：
  - 缓存未热是瞬态：解密失败并置 `pending`，调度器以 1 秒短重试（`v2KeyPending()`）。
  - 凭据库真失败（缺条目/形状不符/读取异常）进入 60 秒冷却：不置 pending、不重读，防每秒风暴；冷却后由 tick 预热自然重试。
  - keyId 失配（宿主换钥/残留旧条目）：不清缓存（清了会把仍可解的条目一起打死），限频 60 秒 force 重读自愈；重读失败保留旧钥；取回同一把钥不产生额外动作。
  - 用户显式动作（chip 立即刷新 / 凭据文件变更 / 「拉取模型」套餐路径）经 `v2KeyRetryNow()` 越过冷却与失配限频；在途读取稍后失败时不开新冷却窗。
  - 挂住的读取释不掉也取消不了：单飞保证不叠加新读取，迟到结果照常采纳。
- 密钥到位、解密成功但 token 临期时，数据源离开「未配置」态（状态迁移先于临期早退），不残留 decrypt 失败文案。
- `model-puller.cjs` 接收主桥注入的 `decryptValue`（即分发器）：套餐 token 的 v2 信封经 `defaultDec` 解。它的每次用户触达先调 `v2KeyRetryNow()`（钥匙串刚解锁时点一下就能拉到）；仍带 `enc:` 前缀的结果一律作废——热换竞窗里旧模块闭包可能透传密文，绝不外发。
  - 「列出供应商」是主桥同步取值的接口：密钥未热那次不含套餐源，但会触发预热。
  - 渲染端在用户选中的是套餐源而列表不含它时，按点击时刻采样的选中项稍等重问一次；仍没有则提示凭据暂不可用，不得改投其它供应商。

## 验收场景

1. `enc:v2:env` 与 `enc:v2:os` 条目在密钥可得时解出明文；额度、订阅、Start Plan、重置卡与套餐模型请求头均为明文 token。
2. 密钥不可得、keyId 不符、密文被篡改、iv 或 tag 长度不符、来源不是 `os`/`env`、未知代际：解不开，零请求。
3. 密钥未热是 pending 短重试；预热落定后下一拍恢复查询；真失败 60 秒冷却内零重读、零请求。
4. `enc:v1` 与明文凭据的行为不变。
5. 主桥注入的 `decryptValue` 无论是当前分发器还是热换竞窗里的旧透传闭包，套餐模型拉取都不外发密文。
6. 选中套餐源而列表暂不含它时，不向任何其它供应商发起拉取。
7. 用户显式动作越过冷却与失配限频；失配 force 重读失败保留旧钥，旧钥继续服务其余条目。

## 未验证

- Windows 凭据管理器与 Linux secret-service：Windows 已由贡献者在实机验证（PR #289），Linux 未实机验证。凭据库条目按凭据文件路径定位，Windows 上路径拼写（盘符大小写、8.3 短名、home 目录来源）是否与宿主逐字符一致未逐项验证，不一致时表现为取不到密钥。
- `env` 来源只有夹具验证和对宿主实现的静态对照，没有真实的 managed secret 环境。
- 凭据库被锁定或需要系统授权时的表现：macOS 一台实机观察到读取即时完成；Windows 实机由贡献者验证；其它情形未验证。
