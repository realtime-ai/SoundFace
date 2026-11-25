# SoundFace 开发版：构建与腾讯会议验证

更新：2026-10-18。本文覆盖当前开发实现；此前 PRODUCT / ARCHITECTURE 文档是产品基线，数字人范围现已调整为 Vidu `subject_replacement`。

## 当前能力与边界

- Electron 工作台：读取真实音频和摄像头设备，独立启停音频、本地预览与虚拟摄像头输出，支持静音、隐私暂停、安装入口与权限提示。未枚举到扩展输入流时，虚拟摄像头按钮保持禁用。隐私暂停会取消尚未完成的权限或启动请求；退出暂停不会自动恢复。
- 原生 Swift / C 音频桥接：两个 AUHAL 分别绑定所选输入和 SoundFace 内部输出，单声道复制或取前两个声道。8 / 16 / 24 / 32 kHz 输入通过 Apple AUConverter 转为 48 kHz；44.1 / 48 kHz 沿用同采样率直通。转换器在启动前初始化，通过预分配环形缓冲读取输入；静音在转换后再次清零，设备失联、采样率改变、回调中断时停止路由。转换不提升原始音质，也不等于时钟漂移补偿。
- 定制 BlackHole：公开输入 `SoundFace Microphone`（`SoundFace_UID`）、隐藏输出 `SoundFace Internal Output`（`SoundFace_2_UID`），与原 BlackHole 标识不同。
- 摄像头扩展：提供 CMIO provider/device/source/sink，1280×720 BGRA / 30 fps。原生 `soundface-video` 可采集所选物理摄像头、缩放裁切并向扩展输入队列提交帧；这条媒体链路已编译但尚未实际运行。输入帧超过 250 ms、格式错误、停止或断开时回退到中性隐私画面。没有 Apple 团队签名，未激活、未验证腾讯会议视频输入。已增加 JS RTC 生成帧到原生输入的功能验证通道；是否可在会议中采集必须以扩展激活后的实测为准。
- 实时数字人：已实测打通 `subject_replacement` → AliRTC → JS 帧桥接 → CMIO → 腾讯会议本机采集，952×544；10 月 18 日会话显示 1,169 帧，确认结束并结算。第二台设备的视频接收和音画同步尚未量化，详见 VERIFICATION.md。
- 角色库：内置青禾，支持原生文件选择器导入 JPG/PNG、预览、筛选、持久保存和移至废纸篓。最多 12 个自定义角色；每张不超过 4 MB，边长 128–4096 像素。会话运行及结束未确认期间锁定导入/移除；运行时不可换角色。美颜参数交互保留，明确提示当前不改变画面。
- 界面：SoundFace Studio 工作台；预览/角色库在左侧，数字人/摄像头输出/声音在右侧。用户界面不展示 API 服务商品牌，保留 AI 合成标识、用量、权限和实际设备状态。
- 界面每 250 ms 显示原生输入和输出回调的采样峰值（dBFS），不保存录音。路由状态和输出回调电平不等于会议接收证明。2026-10-17，HUAWEI FreeClip 2 经 SoundFace 虚拟麦进入腾讯会议，本地试听与另一台设备的远端声音接收均由用户确认正常；端到端时延和长时间稳定性尚未量化。详见仓库 `docs/VERIFICATION.md`。
- 降噪、变声、同传尚未实现。

## 本机开发

需要 macOS、Command Line Tools（含 Swift 和 macOS SDK）、Node.js >=22.12。当前开发机为 Apple Silicon；音频驱动同时编译 arm64/x86_64，应用与辅助程序按构建机架构生成。Electron 的实际系统支持范围以所用版本为准，尚未测试最低 macOS 版本。

```sh
npm ci
node node_modules/electron/install.js
npm run build
npm test
npm start
```

输出：

- `dist/SoundFace-darwin-arm64/SoundFace.app`：本机开发应用，内含音频驱动安装包及摄像头扩展。
- `dist/SoundFace-Desktop-dev.pkg`：安装应用到 `/Applications`，音频组件从应用内另行启动系统安装器。
- `dist/SoundFace-Microphone-dev.pkg`：只安装本产品音频插件到 `/Library/Audio/Plug-Ins/HAL/SoundFace.driver`。

产物为 ad-hoc 开发签名，pkg 未 Developer ID 签名、未公证。不可作为正式对外发布安装包。脚本不会重启音频服务或修改其他音频设备。

## 腾讯会议音频验收

1. 打开桌面开发安装包，将 SoundFace 安装到 `/Applications`。
2. 在 SoundFace 点击“安装音频组件”，在 macOS 安装器中完成管理员授权。应用不收集管理员密码。
3. 安装完成点“刷新设备”。只有系统同时枚举公开输入和内部输出，界面才允许开启虚拟麦。如仍未枚举，请保存工作后重启 Mac，再打开 SoundFace。
4. 选 `MacBook Pro Microphone`、USB 麦克风或蓝牙耳机输入，点击“开启虚拟麦”，允许麦克风权限。蓝牙耳机当前输入可与播放输出使用不同格式；界面显示的采样率来自本次实际输入，例如 `当前输入 16 → 输出 48 kHz`，不是耳机全部能力声明。
5. 打开腾讯会议的音频设置，麦克风选择 `SoundFace Microphone`，扬声器选耳机或 Mac 扬声器。若已打开的会议未刷新列表，退出并重新打开腾讯会议。
6. 使用腾讯会议的麦克风检测说一段话，检查输入电平、试听结果；如有条件，用另一设备加入测试会议验证远端声音。
7. 点击 SoundFace“静音”：确认腾讯会议输入归零；取消静音后恢复。点击“隐私暂停”：采集停止；退出暂停不会自动恢复，须手动开启。
8. 分别验证停止路由、拔掉输入设备、退出应用时不再传声。记录系统/会议版本、设备、结果和异常。

腾讯会议摄像头暂时选物理摄像头。SoundFace 的“开启预览”仅在应用内显示本地画面，不能作为虚拟摄像头已接通的证据。签名激活后，“虚拟摄像头输入”和“开启虚拟摄像头”独立控制原生输出；本地预览的输入选择不会自动改变虚拟输出。

## 原生摄像头开发验证（不依赖 OBS）

扩展位于宿主 `Contents/Library/SystemExtensions/app.soundface.camera.systemextension`。`npm run build:camera` 用 Command Line Tools 编译扩展、视频辅助进程和 `soundface-camera.node`。Node-API 模块使用稳定 ABI；需本地 Node 的开发头文件，可用 `SOUNDFACE_NODE_HEADERS` 指定 `include/node` 目录。

宿主内的原生模块提交 `OSSystemExtensionRequest`，界面显示申请中、等待用户允许、完成、需要重启或真实错误域/错误码。完成回调后仍需刷新检查 CMIO sink 是否出现，不能只凭回调认定会议可采集。普通开发包不带受限安装 entitlement，可在 SIP 开启时做本机功能验证。`node scripts/package-camera-test.cjs` 从普通包生成 `dist/camera-test/SoundFace.app` 和 `dist/SoundFace-Camera-Test-arm64.zip`，专用包加入安装 entitlement 和开发用 app-group；这些不是 Apple 授权签名。专用包在默认系统安全设置下可能被 AMFI 直接拒绝启动，不应覆盖日常使用的普通包。正式发行仍需注册标识、替换为团队 App Group / Mach service、相同 Team 签名和公证。

当前保留 JS AliRTC：只读取订阅 `render_uid` 的远端 video，按最多 15 fps 缩放为 1280×720 并把 AI 标识写入像素。临时 JPEG 通道经过 Electron IPC 和原生辅助进程，最终生成 BGRA `CVPixelBuffer` / `CMSampleBuffer`。每段仅允许一个请求在途，过期帧、旧会话和旧输出令牌会被拒绝；原生像素池最多 4 个缓冲，CMIO 队列最多 2 帧，扩展只保留最新帧。停止或输入帧龄超过 250 ms 后输出中性画面，不以真人画面代替生成画面。这是功能验证方案，尚未完成零拷贝、30 fps 生成输入、音画延迟补偿或长时间性能验收。

无需加载扩展即可点击“检查生成帧链路”：真实生成帧通过相同解码、像素池、缩放及 sample-buffer 封装路径，界面显示原生转换帧数，CMIO 入队保持 0。它不是摄像头输出成功的证明。先开启数字人预览，收到生成画面后再启动此检查；停止检查不结束云端计费，停止云端或隐私暂停会同时结束检查。

### 专用测试机的激活步骤

用户已选择专用环境下手动调整 SIP 进行开发调试。以下步骤只在该测试机执行；当前开发机不会由脚本自动重启或修改 SIP。

1. 保存工作，使用 `dist/SoundFace-Camera-Test-arm64.zip` 中的专用 SoundFace.app，后续在测试机 `/Applications` 安装。
2. Apple Silicon 测试机：关机后按住电源直到显示启动选项，进入“选项”与恢复环境；Intel 测试机：启动时按住 Command-R。
3. 在恢复环境的“实用工具 → 终端”执行 `csrutil disable`，按系统要求由管理员确认，然后重启。
4. 在 macOS 执行 `csrutil status` 确认状态。应用已放 `/Applications` 时不需要 `systemextensionsctl developer on`；该开关只在需要从其他目录激活时使用。
5. 将专用包安装到 `/Applications`，启动 SoundFace，点“申请激活摄像头”。按实际提示，在 macOS 15 的“系统设置 → 通用 → 登录项与扩展 → 摄像头扩展”允许 SoundFace，随后刷新摄像头状态。
6. 如果仍报错，保存完整错误域/码和 `systemextensionsctl list` 输出，再排查 entitlement、bundle 标识和 Mach service。不要把关闭 SIP 等同于激活必定成功。
   当前开发版首次激活后，已有原生 helper 可能尚未刷新设备枚举；若系统列表已 enabled 但界面仍显示待激活，退出并重新启动 SoundFace 后再检查。
7. 设备可见后先选物理摄像头测试 source/sink，再开始青禾生成、选择“数字人画面”并开启虚拟摄像头。在腾讯会议选择 `SoundFace Camera`；声音仍独立选 `SoundFace Microphone`。本机预览、远端接收、停止/断流回退和音画同步分别验收。
8. 测试完成关闭应用并卸载开发扩展；若开启了目录开发模式，先执行 `systemextensionsctl developer off`。进入恢复环境执行 `csrutil enable`，重启后确认已启用。正式发行测试必须在正常安全设置下重新进行。

依据：[Apple 系统扩展调试](https://developer.apple.com/documentation/driverkit/debugging-and-testing-system-extensions)。此处只涉及用户态 Camera Extension，不配置 kext、arm64e boot-args 或关闭其他安全机制。

实现依据：[Apple WWDC22 的 source/sink 模型](https://developer.apple.com/videos/play/wwdc2022/10022/)、当前 SDK 的 CMIOHardwareStream.h / CMIOExtensionStream.h；对照 [OBS 官方 mac-virtualcam](https://github.com/obsproject/obs-studio/tree/master/plugins/mac-virtualcam) 的队列使用方式，项目没有复制 OBS 源文件。

只读诊断（不会开启采集）：

```sh
build/soundface-audio --list
build/soundface-video --list
dist/SoundFace-darwin-arm64/SoundFace.app/Contents/MacOS/SoundFace --diagnose
```

`npm test` 包含权限延迟、暂停期间原生启动完成、退出暂停不自动恢复、音视频独立控制、原生失联、帧过期及静音缓冲测试。自动测试不会开启物理采集。

音频设备绑定依据 [Apple TN2091](https://developer.apple.com/library/archive/technotes/tn2091/_index.html)。使用 AUHAL 的设备侧格式设置客户端格式，避免 AVAudioEngine 缓存默认蓝牙输入格式后与所选内置麦克风不匹配。两个设备仍使用独立时钟，尚无自适应漂移补偿。

## Vidu 实时角色替换

当前采用 S2 Editing `subject_replacement`，显式设置 `editing_type`。内置 `assets/default-character.jpg` 是原创虚构成年角色，直接以 base64 data URI 作为 `image_url` 传入，不依赖公开图床。

1. 选择青禾或导入自己的参考图，直接点击「开启数字人并输出」。收到真实生成帧并确认云端 live 后，自动接通虚拟摄像头；若摄像头组件不可用或当前选择物理输出，则为「开启数字人预览」。可以独立停止摄像头输出而继续生成，再手动恢复输出。客户端不再持有生成服务的 Key：会话由 SoundFace 服务端创建（见下节“服务端代理”），客户端只拿到这场会话的实时通道参数和控制通道的短期 `client_secret`。打包脚本不再注入 `cloud-runtime.json`，`verify:package` 会检查安装包里没有它。

2. 本地摄像头先完成授权和采集检查，再请服务端创建会话。服务端调用上游时 REST Authorization 直接使用 Key，不带 Token 前缀；客户端的 WebSocket 只使用这场会话的短期 `client_secret`。
3. `conn_init_ack.success=true` 后开始计费。主进程持有 WebSocket 和界面心跳；客户端不再设置会话时长上限，由用户手动停止；渲染进程仅收到临时 RTC 凭证。AliRTC 7.3.4 只发布视频，不发布/订阅音频。Electron 权限处理器只为竖屏片段录制放行主界面的麦克风，数字人会话本身不使用音频。
4. 只有 `render_uid` 视频流的 `requestVideoFrameCallback` 收到实际帧才显示「实时生成」。右下角是本地输入对照，AI 合成标识常驻。25 秒没有首帧或收到帧后停滞 10 秒会结束测试。
5. 手动停止、隐私暂停、退出、界面崩溃/失去心跳会结束会话。先停止本地 tracks，再退出并销毁 RTC；发送 type=5 挂断，用 `GET /live/v1/lives/{id}` 确认 `status=ended` 并展示 `billed_seconds` / `credits_cost`。查询未成功时显示「结束未确认」，阻止创建另一场并允许重试结束。

平台文档价格为每秒 1 积分 / ¥0.03125，实际以账户账单为准。断网、主进程被强杀、机器断电时客户端无法保证挂断送达，须以平台结束状态为准；当前验证版不实现跨应用重启的会话恢复。

已接入真实参考图角色库：选中角色后，主进程从其本地副本生成 data URI 作为 `image_url`，在创建付费会话前完成校验。文件保存在 Electron userData 的 `characters/`，不写入源码或安装包；缩略图由本地解码生成，参考图最长边规范到 1024。移除只处理应用副本，使用系统废纸篓，可恢复。

会话之间可以切换角色；同一会话中的实时热切换未实现。未来发送 `switch_prompt` 后应等待真实画面变化，不能自动重复提交。美颜仍仅保留参数交互，不向生成 API 或本地处理管线发送美颜设置。

2026-10-18 核对公开官方 S2 Editing 参数、Quick Start 及其 Demo：`subject_replacement` 必须提供 `image_url`，示例未附可直接使用的默认参考图，也未发现公开的实时角色模板目录接口。通用异步视频模板与实时角色替换不是同一能力，未混用。青禾属于 SoundFace 自有参考素材，不标注为平台官方角色。产品 UI 使用 SoundFace 品牌；内部 API 模块名、来源说明和第三方许可保留真实名称。

SDK 固定版本随应用打包，出处和 SHA-256 在 `app/vendor/NOTICE.txt`。网络策略仅放行 RTC 所需服务域，禁止远程脚本、Node 集成和任意窗口导航；未关闭 Electron sandbox / webSecurity。开发诊断只记录会话状态、帧计数、尺寸及阶段码，不记录 Key、临时凭证或视频帧。

官方参考：
- https://platform.vidu.cn/vidu-stream/doc/s2-editing/parameters
- https://platform.vidu.cn/vidu-stream/doc/s2-editing/quick-start
- https://help.aliyun.com/zh/live/quick-use
- https://help.aliyun.com/zh/live/set-local-audio-and-video-properties
- https://developer.apple.com/documentation/coremediaio/creating-a-camera-extension-with-core-media-i-o

## 服务端（Cloudflare Workers）：账号、credit、兑换码与会话

`workers/` 是 SoundFace 服务端，运行在 Cloudflare Workers 上（取代原来的本地 Node 服务端 `server/`），不打进桌面安装包。**尚未部署**：部署需要负责人提供 Cloudflare 账号（或带 Workers / D1 / Durable Objects 权限的 API 令牌）、开通 Workers 付费版（发邮件需要）和一个托管在 Cloudflare 的域名；Vidu Key 由负责人用 `wrangler secret put VIDU_API_KEY` 自行设置。

- 本地开发：`cd workers && npm install && cp .dev.vars.example .dev.vars && npm run db:migrate:local && npm run dev`，监听 `127.0.0.1:8787`（桌面端开发版默认连这个地址）。根目录 `npm run server` 等价。自动测试：`cd workers && npm test`（起一个真实的本地 workerd，含 D1、Durable Objects 和模拟发信）。
- 存储：D1 存全局索引——账号列表、登录凭证（只存 SHA-256）、登录验证码、兑换码（只存 SHA-256 和尾号）。每个账号一个 Durable Object（`AccountObject`，自带 SQLite），串行处理该账号的余额、充值流水、会话和结算，避免并发重复扣费。
- 登录：邮箱 + 验证码、手机号 + 验证码（`src/auth.js`）。正式发信用 Cloudflare Email Service（`send_email` 绑定，需在 Cloudflare 接入发信域名，并设置 `MAIL_FROM`）；`wrangler dev` 下发信只是模拟。短信服务商未定，正式版暂无手机号登录。`DEV_LOGIN=1` 时启用开发登录：按名字登录，以及验证码固定 000000、不真实发送的邮箱/手机号登录；线上绝不能打开。验证码 5 分钟有效、60 秒内不能重发、最多试 5 次、一次性。手机号和邮箱是两个账号。
- credit：1 credit = 1 分钟。后台按秒记，不足 1 分钟的部分留在账户里，不向上取整；界面显示“剩余 xx 分钟”。新用户试用秒数由 `TRIAL_SECONDS` 决定（线上默认 0，待负责人定）。套餐表在 `src/plans.js`，只用于展示和生成兑换码面额。
- 计费规则：从客户端报告的第一帧生成画面开始，到发出挂断为止；不超过服务商实际向我们收的秒数；没出过画面的会话不扣。客户端失联时只算到最后一次心跳。余额不足 1 分钟拒绝开新会话；会话中余额用完，服务端主动挂断（`quota_reached`）。
- 回收：每个有未结束会话的账号对象每 5 秒被闹钟唤醒一次：30 秒无心跳（`HEARTBEAT_TIMEOUT_MS`）挂断（`client_lost`），余额用完挂断，重试未确认结束的会话，清理创建超时的记录。
- 兑换码：`SF-XXXX-XXXX-XXXX-XXXX`，16 位 Crockford base32（80 位随机）。一次性；同一账号连续输错 5 次锁定 15 分钟。负责人用命令行生成和查询：`npm run codes -- create --plan starter --count 20 [--expires-days 90] --remote`、`npm run codes -- list [--batch …] --remote`、`npm run codes -- show SF-… --remote`。码只在创建时显示一次。
- 服务商：`src/providers.js`，默认模拟服务商 `fake`（不联网、不花钱）。真实 Vidu 需同时设置 `PROVIDER=vidu`、`ALLOW_PAID=1` 和 `VIDU_API_KEY`。服务端挂断 Vidu 改用 Workers 的对外 WebSocket，**尚未对真实上游验证**。`create` 返回与服务商无关的 `{ transport, control }`，接 Xmax 只需新增一个实现。
- 接口：`POST /v1/auth/:method/code`、`POST /v1/auth/:method/login`、`GET /v1/me`、`GET /v1/plans`、`POST /v1/redeem`、`GET /v1/history`、`POST /v1/sessions`、`POST /v1/sessions/:id/heartbeat`（带 `frames`）、`POST /v1/sessions/:id/hangup`、`GET /v1/sessions/:id`。
- 桌面端开发版：`SOUNDFACE_DEV_USER=<名字> npm start` 自动用开发登录；`SOUNDFACE_SERVER_URL` 可改地址（非本机必须 https）。打包版忽略这两个环境变量。
- 风险：Cloudflare 在中国大陆没有备案无法使用境内节点，默认的 workers.dev 域名在大陆经常无法访问；海外发出的验证码邮件进 QQ / 163 邮箱可能进垃圾箱或延迟，域名到位后要实测。

## 直播画面窗口（OBS 窗口采集）

工作台右侧“直播画面”卡片可以打开独立窗口“SoundFace 直播画面”，供 OBS 等直播软件用窗口采集抓取。这条路径不依赖虚拟摄像头扩展。

- 画面固定为 1280 × 720 画布，窗口按 16:9 缩放，最高 30 fps。窗口无边框，拖动画面任意位置即可移动窗口。
- 只会画两种内容：数字人生成画面（叠加 AI GENERATED 标识），或勾选“使用本地测试画面”时的本地合成画面（叠加 LOCAL TEST 标识，不连云端、不开摄像头）。
- 生成画面超过 250 ms 没有新帧（`LIVE_STALE_MS`，沿用虚拟摄像头路径的值，直播中网络抖动可能导致频繁闪占位，待实测调整）、会话未处于 live、隐私暂停时，一律显示“稍后回来”占位画面。摄像头原始画面不是这个窗口的输入。
- OBS：来源 → 添加“macOS 屏幕采集”，方式选“窗口采集”，窗口选“SoundFace 直播画面”。窗口被最小化时，系统会暂停绘制，OBS 也拿不到新画面，请保持窗口可见。窗口被其他窗口完全挡住时是否仍持续刷新，尚待在 OBS 中实测。
- 相关代码：`app/live-output.js`（选源和合成）、`app/live-window.js`（窗口与刷新）、`app/main.cjs` 中只放行名为 `soundface-live` 的空白子窗口。

## 竖屏片段录制

工作台右侧“竖屏片段”卡片录制 9:16 短视频，直接导出 MP4（H.264 + AAC，由 Electron 自带的 MediaRecorder 编码，不需要 ffmpeg）。

- 画面 720 × 1280、30 fps，约 6 Mbps；最长 60 秒，到时自动停止；停止后弹出保存对话框，默认保存到“影片”文件夹。
- 画面来源与直播画面窗口相同：数字人生成画面或本地测试画面，横屏画面居中裁成 9:16。没有新帧时显示占位画面。摄像头原始画面不是输入。
- 当前云端输出 952 × 544，裁切后只有约 306 × 544，放大后明显模糊，不适合直接发布；待云端输出 1080p 或竖屏后改善。
- “变身”转场（默认开）：开头约 1.6 秒，先显示所选 AI 角色参考图的重度模糊暗化版本，再从模糊过渡到清晰的生成画面。参考图是 JPG，没有透明通道，所以不是真正的剪影；需要剪影效果要另做人像分割。
- 每一帧都烧录 AI 标识（右上）和“SoundFace 声面”品牌角标（左下）。
- 可选录入麦克风声音（系统默认麦克风，关闭回声消除、降噪和自动增益）。麦克风经过一个延迟节点再录入，用来抵消生成画面的云端延迟，延迟值 `CLIP_AUDIO_DELAY_MS`（`app/clip-recorder.js`）目前为 0，待实测后填入。隐私暂停会立即停止录制并释放麦克风。
- 开发调试：设置环境变量 `SOUNDFACE_CLIP_DIR` 后（仅未打包的开发版），片段直接保存到该目录，不弹对话框。
- “前后对照”转场（转场下拉框里选）：开头约 2.6 秒，先显示一个通用剪影（与用户本人无关，摄像头画面不进入导出），再从左到右擦出生成画面，标注 BEFORE / AFTER。剪影是可替换素材位：放一张 `assets/compare-before.png` 即替换内置的矢量剪影；没有这个文件时用内置剪影。
- 相关代码：`app/clip-composer.js`（裁切、转场、标识）、`app/clip-recorder.js`（录制与保存）、`app/main.cjs` 中的 `clip-save`。

## 内置角色清单

内置角色由 `assets/characters/manifest.json` 决定，增删角色只改该目录下的图片和清单，不改代码；来源说明见 `assets/characters/SOURCES.md`。清单里的 `file` 只能指向 `assets/` 内的 JPG/PNG，`id` 为小写字母、数字和短横线，不能与自定义角色冲突；不合规的条目会被跳过。清单缺失或读取失败时只保留青禾。打包脚本会复制整个 `assets/characters/`。当前 8 个角色为测试素材（AI 生成，2026-11-25），尚未在真实数字人会话中试过。

## 许可与分发

音频驱动基于 BlackHole `561d934c77a1fa64987e01ccabe890fed30e181f`。包中保留 GPL-3.0 许可证、对应上游源码和定制配置。BlackHole 官方要求 GPL-3.0 应用或单独商业授权；整个 SoundFace 的发行许可尚未确定，当前构建只用于开发验证，不代表具备闭源发布许可。

## 卸载与恢复

先停止输出并退出 SoundFace；删除 `/Applications/SoundFace.app` 不会卸载 HAL。仅移除 `/Library/Audio/Plug-Ins/HAL/SoundFace.driver`，需要管理员授权，之后保存工作并重启以卸载已加载的驱动。不要删除 BlackHole 或其他厂商插件。摄像头当前未激活，因此无需停用系统扩展；未来激活版应先执行系统停用流程。

音频环形缓冲保证静音、欠载补零和积压裁剪；设备之间的时钟漂移尚未做自适应重采样。长时运行的延迟、稳定性和音质仍需测量。


## 免费本地摄像头链路检查

“摄像头输出”的“输出画面”可选“本地测试画面 · 免费”，点击“开启虚拟摄像头”。彩条、移动色块、递增 FRAME 号和运行秒数直接在本机生成，不打开物理摄像头、不创建数字人或调用云端 API。

该输入使用与实时数字人相同的 canvas/JPEG → IPC → 主进程令牌检查 → 原生 JPEG/BGRA/CMSampleBuffer → CMIO sink → Camera source 路径。测试会话 ID 与付费会话独立；停止、隐私暂停和退出均禁止继续转发。测试画面标记 LOCAL TEST，数字人画面继续保留 AI GENERATED 标识。可在腾讯会议中持续观察帧号与色块变化、切至后台/最小化、停止回到隐私占位、再手动恢复。


## 无首帧诊断与传输对照

“数字人 → 连接诊断”记录每次尝试的传输选择、RTC 入会、视频发布状态、生成端上下线/订阅和首帧。主进程将相同的受限枚举/数字历史及会话 ID、阶段、服务端 close_reason / trace_id 存到 userData 下 `cloud-diagnostic.json`，保留最多 32 个阶段；不记录 SDK 原始对象、URL、token、密钥或媒体内容。使用独立 IPC 推送诊断，避免诊断事件触发云端生命周期处理。

默认传输仍为 SDK 自动选择。开发时可用 `SOUNDFACE_RTC_TRANSPORT=tcp` 做一次 TCP 优先对照；通过当前 SDK 7.3.4 的 `setParameter({net:{useTCP:true}})` 路径将媒体配置映射到 tcpOnly，不改变 TLS、权限或防火墙。这个参数来自当前随包 SDK 实现核对，尚不承诺跨版本兼容；不得在没有真实验证时宣称已修复网络问题。

控制接口可达并不证明 ICE/DTLS/RTP 上行已通；SLS 日志上报 TLS 失败也不能直接当作媒体失败原因。服务端 `live_ended` 是通用结束码，需要结合视频发布状态与服务商 trace_id 继续诊断。
