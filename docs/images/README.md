# 界面截图来源

本目录的三张 PNG 是 **1.0.0 脚本实际界面**的浏览器截图，使用空白、隔离的 Edge 配置。题目、账户、余额与 API 均为模拟数据，图中标有「演示数据」。

| 文件 | 展示内容 |
| --- | --- |
| [compact-overlay.png](compact-overlay.png) | 下方居中的精简参与卡片。 |
| [fullscreen-confirm.png](fullscreen-confirm.png) | 调用实际 Fullscreen API 后的参与确认框。 |
| [settings.png](settings.png) | 浮窗与自动参与设置，自动模式为默认关闭。 |

播放器背景是为演示编写的原创 SVG 山景，作为模拟视频 poster 使用；没有使用实际直播或游戏画面。脚本的卡片、确认和设置控件保持原样。

拍摄通过 Playwright 的可信鼠标事件（`isTrusted=true`）进入全屏、点击选项并取消；未确认参与。11 次账户／题目 API 均由模拟后端响应，模拟与真实参与 POST 均为 0。临时浏览器已清理。

脚本通过测试注入运行，本次拍摄不包含 Tampermonkey 扩展安装或真实账号验收。详情见 [screenshot-provenance.json](screenshot-provenance.json)。
