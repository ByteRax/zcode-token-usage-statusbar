# -*- coding: utf-8 -*-
"""测试共享：符号链接创建能力探测。

Windows 上 os.symlink 需要 SeCreateSymbolicLinkPrivilege（管理员或开发者模式），
无该特权的机器上相关测试应跳过而不是报错（WinError 1314）。探测结果按进程缓存。
"""
import os
import tempfile

_CAN_CREATE_SYMLINKS = None


def can_create_symlinks():
    """本进程能否创建符号链接（探测失败也算不能，宁可跳过不误报）。"""
    global _CAN_CREATE_SYMLINKS
    if _CAN_CREATE_SYMLINKS is None:
        try:
            with tempfile.TemporaryDirectory(prefix="zusage-symlink-probe-") as d:
                target = os.path.join(d, "target")
                link = os.path.join(d, "link")
                with open(target, "w", encoding="utf-8") as f:
                    f.write("x")
                os.symlink(target, link)
                _CAN_CREATE_SYMLINKS = os.path.islink(link)
        except (OSError, NotImplementedError):
            _CAN_CREATE_SYMLINKS = False
    return _CAN_CREATE_SYMLINKS
