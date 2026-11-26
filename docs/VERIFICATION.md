# 开发验收记录

记录日期：2026-10-16，更新至 2026-10-18。环境：macOS 15.1.1 (24B91)，Apple Silicon，腾讯会议 3.46.11。已完成音频驱动安装、系统加载、实际音频路由和腾讯会议本地麦克风检测；2026-10-17 用户进一步确认另一台设备在实际会议中听到声音，声音正常。端到端时延与长时间稳定性尚未量化。

| 项目 | 状态 | 证据 / 未完成部分 |
| --- | --- | --- |
| HAL 驱动编译 | 通过 | `npm run build` 成功，arm64 + x86_64，ad-hoc 签名校验通过 |
| Swift / C 音频桥接编译 | 通过 | 主机 arm64，最低编译目标 macOS 13.0；AUHAL 显式绑定实体输入与隐藏输出 |
| Camera Extension 编译与激活 | 通过 | 10 月 18 日专用开发环境已激活并启用；物理输入、生成帧和停止占位画面均通过腾讯会议本机预览 |
| Electron 应用与 pkg | 构建通过 | `dist/SoundFace-darwin-arm64/SoundFace.app`、Desktop 与 Microphone 两个开发 pkg |
| 打包完整性 | 通过 | `node scripts/verify-package.cjs` 校验原生资源、隐私描述、扩展位置、代码签名、驱动路径和密钥排除 |
| 控制与原生桥接测试 | 33 项通过 | 系统枚举、回路拦截、错误恢复、音视频独立控制、权限/启动与隐私暂停竞态、扩展缺失拒绝输出、原生音量读数与过期事件处理；新增 Vidu 密钥隔离、占位角色拒绝、重复启动保护、创建/初始化取消、自动挂断和结束查询未确认测试 |
| 视频帧保护测试 | 通过 | AddressSanitizer；最新帧替换、250 ms 过期、停止清空、时间回退、尺寸/像素格式拒绝 |
| 音频缓冲测试 | 通过 | AddressSanitizer + UndefinedBehaviorSanitizer；单/双声道、欠载补零、静音排空、回绕、溢出与积压裁剪 |
| 打包应用原生诊断 | 通过 | `SoundFace.app/Contents/MacOS/SoundFace --diagnose` 真实返回设备列表与 TCC 状态 |
| 依赖审计 | 通过 | `npm audit`：0 vulnerabilities（只代表当时数据库中的已知问题） |
| 音频组件安装 | 通过 | macOS 安装器完成授权；HAL 路径存在，root:wheel；安装收据 `app.soundface.audio.installer` 0.1.0，驱动签名校验通过 |
| 桌面应用安装 | 通过 | 最新开发应用已复制到 `/Applications/SoundFace.app` 并从该路径启动，deep / strict 签名校验通过，音频辅助程序与构建产物 SHA-256 一致 |
| 系统音频重载 | 通过 | 用户确认后通过活动监视器退出 coreaudiod；系统自动重启服务，PID 从 428 变为 98145 |
| SoundFace 设备可见 | 通过 | CoreAudio 实测 `installed=true`、`internalOutput=true`，公开名称 `SoundFace Microphone`，UID `SoundFace_UID` |
| 腾讯会议设备选择 | 通过 | 音频设置已选中 `SoundFace Microphone`；扬声器仍为系统默认耳机 |
| 物理麦 → 虚拟麦 | 通过 | MacBook Pro Microphone，48 kHz；原生输入 / 输出回调均持续有帧，示例峰值 −38.2 / −39.2 dBFS；腾讯会议用户试听确认 |
| 腾讯会议本地检测有声音 | 通过 | 麦克风选择 SoundFace Microphone；启动检测后用户明确回复“听到了” |
| 腾讯会议远端声音接收 | 用户确认通过 | 2026-10-17，HUAWEI FreeClip 2 → SoundFace 采样率转换 → SoundFace Microphone → 腾讯会议 → 另一台设备；用户明确回复“另一台设备已听到，声音正常”。未量化时延、丢包或长时间音质 |
| 原生路由启停恢复 | 通过 | 修正 AVAudioEngine 缓存格式崩溃，改用两个 AUHAL；真实路由正常启动、停止，退出后音频辅助进程不存在 |
| 静音与取消静音 | 通过 | 安装版原生回调：静音时输入 −34.3 dBFS、输出 −∞ dBFS；取消静音后输入 −37.6 / 输出 −38.6 dBFS。数值来自实际采样，不由静音按钮状态模拟 |
| 隐私暂停与手动恢复 | 通过 | 运行中点击暂停后停止原生路由；退出暂停仍未采集；手动开启后输入 −35.1 / 输出 −33.0 dBFS |
| 运行中退出清理 | 通过 | 从 `/Applications` 安装版运行路由时退出，确认原生音频辅助进程已退出 |
| Electron 界面检查 | 通过 | 解锁后完成真实窗口检查；设备列表、安装入口、云端流程弹窗可操作 |
| 本地摄像头预览 | 通过 | FaceTime HD Camera 真实画面可见；隐私暂停停止采集，退出暂停不自动恢复 |
| 摄像头系统激活 | 专用环境通过 | 用户手动准备的 SIP 开发环境，app.soundface.camera 已 activated enabled；不代表常规签名发布条件已满足 |
| 腾讯会议实际有视频 | 本机采集通过 | 物理摄像头、数字人生成帧、停止后隐私占位均通过；第二台设备视频接收未验收 |
| Vidu 主体替换真实回显 | 功能验证通过 | `subject_replacement` + 青禾 base64 参考图；AliRTC 发布物理摄像头、仅订阅 render_uid 视频；952×544，60 秒会话累计显示 1,076 帧，初始化后约 3 秒收到首帧 |
| 角色动作跟随 | 用户确认通过 | 用户观察转头、张嘴或抬手的交互后回复“动作跟随正常”；未量化动作到动作的端到端时延 |
| 云端自动结束 | 通过 | 60 秒自动发 hangup，查询返回 ended / billed_seconds=60 / credits_cost=60 |
| 云端隐私暂停 | 通过 | 第二次成功回显显示 218 帧后暂停，画面和摄像头 track 清除；查询 ended / billed_seconds=15 / credits_cost=15；退出隐私模式保持未采集、未连接 |
| 多角色选择 | 会话间选择通过 | 青禾默认角色 + 导入参考图；真实导入、选择、重启持久化、移除至废纸篓和取消导入通过。未实测不同人物的生成效果，同一会话热切换未实现 |
| 美颜参数交互 | 通过 | 开关启用/禁用滑块，磨皮实测改至 51 后恢复 30，肤色 20 / 五官 0 恢复；未接入图像算法 |
| 云端连接稳定性 | 尚需优化 | 一场修复域名策略后仍出现渲染服务提前结束（live_ended，10 秒），重试后恢复。当前为短时功能验证，不是生产稳定性验收 |

早期记录（后续激活结果见下文）：原生视频程序可枚举 FaceTime HD Camera，`installed=false`。控制程序与测试不会自动请求或开始物理摄像头采集。

开发版使用 ad-hoc 签名，重新打包会改变代码签名哈希，macOS 可能重新请求麦克风权限。安装版已完成重新授权及静音、隐私暂停、手动恢复、运行中退出验证。普通发布仍需 Apple 团队签名；专用环境激活结果见 10 月 18 日记录。

证据：`build/soundface-audio-verified.png` 为安装版真实运行界面，`build/tencent-soundface-selected.png` 为腾讯会议设备选择界面。腾讯会议本地试听及远端声音接收通过来自用户确认；未量化端到端时延、长时间时钟漂移或远端音质。热拔插和 44.1 kHz 实机组合尚未验收；蓝牙输入的后续验证见下文。

## Vidu 验证补充

实际验证通过开发运行的 Electron 44.7.2 完成，最终安装包包含相同实现。会话永久 Key 未写入源码、包或日志。60 秒成功记录 live_id=`1008567162178121728`；隐私暂停成功记录 live_id=`1008568173533859840`。脱敏账单与帧数汇总在 `build/vidu-verification.json`，界面截图 `build/soundface-vidu-live.png` 展示实际生成角色及本地输入对照。

首帧时间由界面收到视频帧后的心跳统计，精度约 1 秒，起点是 conn_init 成功，不包含本地授权/角色创建时间，也不是动作到动作端到端延迟。未测量动作同步延迟、画质一致性、多角色实时切换和长时间网络抖动恢复。虚拟摄像头的 CMIO 输出和腾讯会议采集仍未验证；不能将云端回显视为会议已接通。

本次五场联调经平台逐场查询均为 ended，计费秒数分别 15 / 10 / 60 / 10 / 15，共 110 秒 / 110 积分。平台文档单价折算约 ¥3.44，实际扣费以账户账单为准。

## 2026-10-17 蓝牙麦克风兼容性验证

- 直接读取 CoreAudio 的设备名义采样率、输入/输出流的物理格式及可用格式。HUAWEI FreeClip 2 的当前麦克风端点报告 16,000 Hz / 1 声道；未采集时播放端点为 44,100 Hz / 2 声道，开始采集后切为 16,000 Hz / 1 声道。该结果描述本次 Mac 蓝牙连接，不是耳机在所有连接方式下的完整规格。原始只读结果在 `build/audio-device-formats.json` 和 `build/audio-device-formats-running.json`。
- 修复音频桥只接受 44.1 / 48 kHz 的限制。8 / 16 / 24 / 32 kHz 经预初始化的 AUConverter 转成 48 kHz；界面分别显示当前输入与输出采样率。未修改 HAL 驱动，也没有重载系统音频服务。
- `npm test`：19 项 JavaScript 测试、原有音频 ring / 视频 FrameStore 检查通过；新增四种采样率转换测试通过 ASan / UBSan，检查 2 秒连续 1 kHz 信号的音高、幅值、单声道复制、不同块大小、静音耗尽和帧数上限。
- 开发安装包与签名校验通过。更新后的 `/Applications/SoundFace.app` 已用 HUAWEI 输入实际启动，界面显示输入 / 输出实测电平及 `当前输入 16 → 输出 48 kHz`，无原采样率拒绝错误。截图：`build/soundface-bluetooth-mic.png`。
- 腾讯会议已选择 `SoundFace Microphone` 并启动本地麦克风检测；用户明确确认“听到了，声音正常”。输入为 HUAWEI FreeClip 2，声音经本地采样率转换后从虚拟麦进入腾讯会议。
- 安装版静音实测：输入 −73.4 dBFS，输出 −∞ dBFS；取消静音后输出恢复为 −74.2 dBFS。截图 `build/soundface-bluetooth-muted.png`。隐私暂停后采集停止，退出暂停仍保持未采集，手动重新开启后输入 / 输出均为 −76.4 dBFS。以上为实时电平，不是预设演示值。
- 远端会议声音接收通过：用户使用另一台手机或电脑加入实际腾讯会议，并明确回复“另一台设备已听到，声音正常”。证据为用户实际试听确认，不是根据本机电平推断；未取得接收端录音或量化延迟数据。
- 验收后保持耳机路由运行，未执行退出应用或重装以免打断会议。长时间漂移、热拔插、睡眠唤醒尚未验收。


## 2026-10-17 JS RTC → 原生视频帧验证

- 保留 JS AliRTC，对 `render_uid` 的真实生成画面增加有界 JPEG 功能验证通道，最多 15 fps、单帧在途、最大 512 KiB；AI 合成标识写入像素。主进程校验会话、输出令牌和帧龄，原生转换为 1280×720 BGRA / CMSampleBuffer。原始镜头不会作为生成输出的后备源。
- 24 项 JavaScript 测试、FrameStore / JPEG 解码 ASan 检查、真实原生 helper 的合成测试帧转换，以及音频 ring / 重采样回归通过。覆盖停止、异步编码取消、旧会话/旧令牌、超时、非法帧和有界背压。证据 `build/video-verification-tests.log`；保留帧龄时间戳调整后 6 项相关测试再次通过，见 `build/video-focused-tests.log`。
- 实际 Vidu 两场：第一场未收到远端帧，服务端在 10 秒后结束；第二场真实回显 952×544，共显示 954 帧，首帧约 2.0 秒，隐私暂停结束时账单 55 秒。两场均确认 ended，共 65 秒 / 65 积分。
- 第二场累计 386 帧通过 Electron → 原生请求；本机通道走真实 JPEG 解码、CVPixelBuffer 池、CoreImage 渲染和 CMSampleBuffer 封装，但 **CMIO 入队为 0**。原生计数在首轮运行中由 54 增至 354；重新启动后另计数，截图数据每秒更新，不把它们相加冒充精确最终总数。平均读帧/编码 6.7 ms，IPC/原生处理 5.3 ms；不是云端或会议端到端延迟，也不是 P95。
- 窗口最小化后恢复，云端计时 18→34 秒期间，原生转换计数 105→257。停止本机验证后，传递计数保持 360，而远端回显 751→863，证明停止输出与继续云端回显独立。手动重启恢复传帧；隐私暂停停止采集并确认云端 ended，退出暂停未自动恢复。
- 证据：`build/remote-frame-live-test.png`、`build/remote-frame-privacy-test.png`、`build/video-session-evidence.json`。无录音、无生成视频文件保存，永久 Key 未写入源码或包。
- 日志出现 H.264 BUNDLE / PT 102 fmtp 差异（`sps-pps-idr-in-keyframe`）以及 RTC 连接错误。第二场仍可正常收帧，尚不能确定首轮失败原因；需要单独排查 SDK 与 Chromium 协商兼容性。
- 打包实测：ad-hoc 宿主带受限安装 entitlement 时，当前 SIP 开启的 macOS 被 AMFI 拒绝启动（退出 137，日志提示 restricted entitlements）。因此普通功能验证包不带该权限；专用摄像头测试包另行加入。普通包的原生激活模块可加载并读取真实签名元数据；专用包尚未在调整 SIP 的环境运行。
- **仍未验收**：系统扩展实际激活、CMIO source/sink 实际送帧、腾讯会议本地/远端视频采集、音画同步、长时间运行和网络断流实机回退。当前成果不能标记为腾讯会议视频全链路通过。

## 2026-10-17 专用测试机安装准备

- 用户确认使用当前 Mac 作为专用测试机，并自行进入恢复模式调整 SIP。检查时 macOS 为 15.1.1，`csrutil status` 仍为 enabled；未执行关机、重启或修改安全设置。
- 已退出普通版 SoundFace，从 `dist/SoundFace-Camera-Test-arm64.zip` 解压并安装专用包到 `/Applications/SoundFace.app`。安装前后 `codesign --verify --deep --strict` 均通过，宿主实际包含 `com.apple.developer.system-extension.install=true`。此校验只证明包的签名结构完整，不代表系统批准加载。
- 扩展 bundle ID、Mach service 和开发用 application-group 均为 `app.soundface.camera`；实际运行权限仍须在激活后验证。普通版备份在 `build/normal-app-backup-20261017-180649/SoundFace.app`。
- 专用包尚未启动或申请激活，等待恢复模式配置及重启。当前 `systemextensionsctl list` 无 SoundFace，原生设备枚举 `installed=false`，只有物理 FaceTime HD Camera；没有激活回调结果，不能标记扩展可用。
- 安装证据及包 SHA-256：`build/camera-test-installation.json`。重启后继续核对 SIP、启动专用包、申请激活，记录真实系统回调、扩展列表和摄像头枚举三项结果。

## 2026-10-18 摄像头扩展激活与腾讯会议采集

- 当前专用测试 Mac 的 `csrutil status` 实测为 disabled。专用包从 `/Applications/SoundFace.app` 成功启动并提交激活请求；先收到用户批准回调，用户在系统设置允许后，界面收到激活完成结果。`systemextensionsctl list` 显示 `app.soundface.camera (0.1.0/2)` 为 `[activated enabled]`。
- CMIO 实测设备 UID 为 `app.soundface.camera.device`，包含 `SoundFace Video` source（legacy direction 1）和 `SoundFace Frame Input` sink（direction 0）。首次激活后已有 helper 未立即刷新设备枚举，重启 SoundFace 后恢复；此首次激活刷新问题尚需优化。
- 腾讯会议视频设置选择 `SoundFace Camera`，实际显示扩展的深绿底、绿色方块隐私画面。随后开启物理源路由，腾讯会议显示真人动态画面；观察到入队至少 1,093 帧、丢弃 0 帧。该计数是生产端计数，不能换算为会议实际帧率或端到端延迟。
- 停止虚拟输出后，腾讯会议实际回到隐私占位画面。截图分别为 `build/tencent-camera-slate.png`、`build/tencent-camera-physical-live.png`、`build/tencent-camera-stopped-slate.png`。当前结果证明本机腾讯会议的 source/sink 帧链路已通，尚未证明第二台设备接收、Vidu 生成帧输出或音画同步。
- 实机发现扩展激活后，浏览器默认输入可能变为 SoundFace Camera，造成应用回采自身占位图。新增 `app/camera-input.js`，按设备列表排除 SoundFace Camera、显式绑定输入 deviceId，并在返回虚拟 track 时停止并拒绝。已更新安装版和专用测试 zip；27 项 JavaScript 测试及原生测试通过，记录在 `build/camera-activated-tests.log`。安装版源码与工作区一致，包验证通过。
- 修复版重新签名后 macOS 再次要求 SoundFace 摄像头授权，用户已允许。修复版默认预览实际选中 FaceTime HD Camera，后续 Vidu 会话使用物理输入，未再回采 SoundFace Camera。
- **Vidu → CMIO → 腾讯会议本机采集通过**：使用青禾真实角色替换，云端显示 952×544 / 1,169 帧，首次生成帧约 4.0 秒（从云端连接确认起算，不是端到端延迟）。生成帧经 JPEG / IPC / BGRA / CMSampleBuffer / CMIO sink 输入 SoundFace Camera，腾讯会议的视频设置预览实际显示数字人，AI 标识包含在视频像素中。证据 `build/tencent-camera-vidu-live.png`。
- 生成帧输出首轮入队 309 帧，手动恢复后的第二轮入队 89 帧，累计传递 398 帧，两轮均报告丢弃 0。平均读帧/编码 6.9 ms、IPC/原生处理 5.3 ms；这些是本机通道均值，不是云端、会议端到端时延或 P95。
- 计时约 43 秒停止虚拟输出，腾讯会议回到占位图；云端继续生成，到约 47 秒显示帧计数由 807 增至 904，原生传递计数保持 309。约 51 秒手动重新开启，腾讯会议恢复数字人画面。约 58 秒触发隐私暂停，会议回到占位图，采集/原生输出停止，应用查询确认云端结束，账单为 58 秒 / 58 积分。退出隐私暂停后保持未采集，未自动开启新云端会话。
- 停止、恢复及隐私证据：`build/tencent-camera-vidu-stopped.png`、`build/tencent-camera-vidu-restarted.png`、`build/tencent-camera-vidu-privacy.png`；帧计数和结算记录在 `build/camera-vidu-live-ax.txt` / `build/camera-vidu-final-ax.txt`，结构化证据在 `build/camera-activation-evidence.json`。测试结束保持应用运行、摄像头/虚拟输出/麦克风关闭、云端 ended。
- 用户明确选择先完成本机验证，本次未创建会议或邀请其他设备。**仍未验收**：视频远端接收、音画同步、量化端到端时延、生产签名环境、长时间稳定性和实际网络断流/进程崩溃后的回退。SIP 仍为 disabled，测试包为 ad-hoc 开发签名。


## 2026-10-18 Studio 界面与角色库

- 新工作台统一使用 SoundFace 品牌，生成源名称为“数字人画面”；移除服务商品牌文案，保留输出像素内的 AI 合成标识。布局在 1240×900 真实 Electron 窗口检查，角色库及三个主要启动入口可见，详细诊断折叠。
- 官方实时 S2 Editing 参数与 Demo 未发现可直接获取的默认角色目录；`subject_replacement` 必填 `image_url`。使用 SoundFace 自有青禾参考素材并提供自定义参考图，不把通用离线模板标成实时数字人。
- 原生选择器导入内置素材的测试副本，数量 1 → 2，自动选中；退出后重启，角色仍在，能重新选择。通过“移除”恢复为 1，应用副本进入系统废纸篓，原始测试图片仍在。取消第二次导入不改变数量。没有上传该测试图片或创建付费会话。
- “我的”筛选、会议接入指南、无密钥启动转到云端连接设置均可操作；界面未显示服务商品牌。美颜参数开启后可编辑，磨皮 30 → 31，恢复默认后回到 30 / 20 / 0，界面明确提示当前不改变画面。
- 33 项 JS 测试及原生帧/音频缓冲/重采样检查通过，含角色 ID 到参考图实际解析、持久保存、移除保留原图、坏图片预检、元数据/符号链接拒绝、自定义参考图 POST、不可读参考图不创建付费会话。结果在 `build/studio-ui-tests.log`。
- 本轮不重复已有付费数字人会话与会议采集验收；未改变 RTC 帧泵、CMIO 和音频采集实现。不同导入人物的实际生成质量仍需按素材验收。

- 新版已更新并从 `/Applications/SoundFace.app` 启动；安装版归档和三个原生资源 SHA-256 与构建包一致，deep/strict 签名检查通过。系统摄像头扩展保持 activated enabled，界面确认摄像头设备可见、虚拟麦可用。最终界面 `build/soundface-studio-ui.png`；结构化检查 `build/studio-ui-verification.json`。结束时画面、声音和云端会话均未开启。


## 2026-10-18 内置云端服务配置

按用户要求取消终端用户配置：移除云端连接按钮、密钥弹窗、前端配置处理及 cloud-configure IPC。主进程自动读取构建注入的服务配置，重启后无需再次输入；缺失或无效配置时停止数字人入口并显示通用提示。独立开发者配置被 Git 忽略且不进入源码压缩包；开发安装包按本次要求包含可提取的服务凭证，正式发布前需迁移至服务端会话代理。

服务配置加载/覆盖、缺失/格式错误/超大配置，以及现有会话密钥不进入 IPC、计费结束与取消行为共 11 项针对性测试通过。没有创建新的付费会话。

- 全量 JS 测试共 35 项通过，打包资源与自动配置匹配检查通过。对已有且已结束会话发送只读 GET，返回 HTTP 200 / ended，验证内置凭证可用，未创建会话、未上传视频。

- 新版已安装到 `/Applications` 并重启：数字人待机、开启按钮可用，无连接设置或密钥输入；摄像头与虚拟麦设备仍可枚举。界面证据 `build/soundface-builtin-service.png` / `build/builtin-service-installed-ax.txt`。更新停止了原有本地预览与虚拟麦，未自动恢复采集。


## 2026-10-18 摄像头输出命名

工作台“会议输出”更名为“摄像头输出”，标题使用摄像头线框图标，接入指南同步更新。已重新打包、校验并安装；真实窗口确认新标题、图标、指南和设备状态。仅文案与图标调整，没有启动采集或新增付费会话。截图 `build/soundface-camera-output-label.png`。


## 2026-10-18 手动结束与免费本地视频链路

- 问题现场：用户截图中的深绿背景/中心绿色方块与扩展隐私占位完全一致；旧应用显示“60 秒验证已自动结束”，已结束会话显示 894 个生成帧、60 秒账单，但本次运行的转发计数为 0，未接通摄像头生成帧输入。
- 删除客户端会话时长截止计时器与 UI 上限。模拟时钟推进到 90 秒时健康会话仍 live，手动结束后确认 ended；失去心跳的保护仍通过。取消输入前后的竞态、晚到的原生启动停止、一键输出只触发一次均覆盖。
- 数字人默认入口在选择数字人输出时为“开启数字人并输出”：等待真实帧、主进程 heartbeat 确认 live 后接通输出；可独立停止/恢复摄像头。一次真实尝试未收到远端帧，服务端结束；重试结束后确认账单 10 秒 / 10 积分。用户随后要求节省费用改用模拟数据，此后不再创建数字人会话。真实数字人超过 60 秒的会话与新的一键输出端到端仍未完成实测。
- 新增“本地测试画面 · 免费”，动态色块、递增 FRAME、运行秒数与彩条，不申请物理摄像头权限、不创建云端会话。通过实际 JS canvas/JPEG → IPC 令牌门控 → 原生解码/转换 → CMIO sink/source → 当前腾讯会议画面。测试图明确标记 LOCAL TEST。
- 开发运行实机：腾讯会议先显示 FRAME 000045 / 3.0 秒，再到 FRAME 000380 / 25.4 秒；对 SoundFace 执行最小化后，运行 67 秒时腾讯会议显示 FRAME 001012 / 67.7 秒，证明连续输出超过 60 秒且切后台不退回占位。随后应用读数累计原生入队 803 帧、原生丢弃 0；该数字不包含编码前的帧率限流，不代表 15 fps 的端到端吞吐保证。数字人全程待机，声音未开启。
- 停止后腾讯会议回到隐私占位；手动恢复后重新入队；隐私暂停停止转发，退出暂停不自动恢复。截图 `build/tencent-local-test-first.png`、`build/tencent-local-test-background-67s.png`、`build/tencent-local-test-stopped.png`；AX 计数 `build/local-test-background-ax.txt` / `build/local-test-privacy-off-ax.txt`。
- 42 项 JS/桥接测试通过，包含本地模拟动态变化、Canvas 源走相同帧泵、测试标识及浏览器计时器调用约束。结果 `build/local-camera-tests.log`；原生视频辅助程序已重编译。

- 最终修复版已安装并启动；安装版 app.asar 与原生视频程序和构建产物一致。已选择本地免费测试并开启输出，腾讯会议实际显示 FRAME 000097 / 6.4 秒；数字人待机、麦克风与实体摄像头未开启。保留免费测试输出供用户继续观察，可手动停止。安装版证据 `build/tencent-local-test-installed.png` / `build/soundface-local-test-installed.png` / `build/local-test-installed-ax.txt`，汇总 `build/local-camera-verification.json`。


## 2026-10-18 无生成首帧诊断

- 用户报告“已停止 · 尚未收到生成画面 · 云端结束已确认”。只读查询既有会话：一次 user_hangup 为 8 秒，随后三次 live_ended 均为 10 秒；最近一次结算 10 秒 / 10 积分。证据 `build/no-frame-existing-session-status.json`。本轮没有创建新的付费会话。
- 真实客户端控制台显示 publisher 使用 UDP 并反复 PC restore；控制接口可达、系统 HTTP/HTTPS/SOCKS 代理关闭。日志上报域名另有 TLS 错误，不能据此判定媒体通道失败原因。live_ended 是通用服务端关闭原因，尚未确认是 ICE/UDP 路径、生成端状态或其他原因。
- 新增有界、白名单连接诊断，记录加入房间、视频发布、生成端上线与订阅、首帧及停止；不保存 SDK 原始对象、鉴权 URL 或凭证。主进程将安全字段写入用户数据目录 `cloud-diagnostic.json`，工作台“连接诊断”可查看。无帧且服务端 live_ended 时改为“生成连接中断 · 未收到画面”。
- 新增开发环境开关 SOUNDFACE_RTC_TRANSPORT=tcp，依据随包 SDK 7.3.4 的 net.useTCP 实现进行单独对照；默认仍为 auto。尚未进行真实 TCP 付费对照，不能认定已修复连接问题。
- 44 项 JS/桥接测试通过，新增诊断的白名单、容量限制、去重与隔离检查。常规包资源校验和专用摄像头测试包构建通过；已备份旧应用，将专用诊断版安装到 /Applications，deep/strict 签名和 app.asar 一致性校验通过。真实窗口确认“连接诊断”展开显示“尚未连接数字人服务”，摄像头设备可见、虚拟麦可用，未开启摄像头、麦克风、虚拟输出或云端会话。证据 `build/connection-diagnostic-installed-ax.txt`。


## 2026-10-18 单次 TCP 设置对照

- 用户明确授权一次目标约 15 秒的短测。使用已安装应用，以 SOUNDFACE_RTC_TRANSPORT=tcp 启动；只点击一次“开启数字人并输出”，从点击开始约 15.8 秒请求停止，未自动创建第二次会话。
- 相对点击时间：5.35 秒生成端上线，6.22 秒视频发布 2→3（Published），订阅进入 2（Subscribing），6.23 秒 joinChannel 返回；11.79 秒发布 3→4（Reconnecting），订阅变 4；14.87 秒生成端离线。全程 0 个生成首帧，未启动虚拟摄像头输出。
- SDK 7.3.4 源码中 videoPublishStateChanged 参数为旧状态、新状态、上一状态持续秒数；日志 3-4-5 的 5 不是错误码。Published 表示 SDK 发布流程成功，不能代替 RTP 字节统计或生成端实际收到媒体的证明。
- 手动停止后应用确认 ended；对该既有 live ID 再做只读 GET 返回 HTTP 200 / ended / live_ended，实际结算 10 秒 / 10 积分。追踪 ID 45dc6c3da4aaf966e401cf07b2234478。证据 `build/tcp-trial-status.json`、`build/tcp-trial-diagnostic.json`、`build/tcp-trial-final-ax.txt`。
- 本次 TCP 设置未解决无帧问题，且尚未取得 selected candidate pair，因此不能断言实际媒体使用 TCP，也不能断言 UDP 阻断是根因。SDK 的 tcpOnly 在有 TCP candidate 时才过滤 UDP；后续应补充脱敏 candidate pair / outbound 与 inbound RTP 统计，并结合该追踪 ID 查询服务端媒体与生成日志，避免继续盲目付费重试。
- 测试后退出带 TCP 环境变量的进程，正常重新打开安装版；所有采集和输出保持停止。未改默认传输策略或系统网络设置。


## 2026-10-18 SoundFace 应用图标

- 使用内置 image_gen 生成原创品牌图标：深森林绿圆角底、薄荷绿人脸与三段声波、透明外边距、无文字。母版与完整提示词保存在 assets/icons/soundface-source.png / assets/README.md；生成的 1024 px PNG 用于侧栏与开发 Dock，macOS ICNS 用于安装包。
- 新增 scripts/build-icon.cjs，使用系统 sips / iconutil 生成 16–1024 px 资源。打包自动执行，显式装入 PNG 与 ICNS；源码包包含可重建的母版和脚本。包验证增加 PNG、CFBundleIconFile 所指 ICNS 与工作区逐字节一致检查。没有新增第三方图像处理依赖。
- 图标各尺寸资源结构与 alpha 检查通过；小尺寸 64 px 预览可辨认脸部和声波。主进程、打包与校验脚本语法通过，打包校验与 deep/strict 签名通过。标准开发 pkg 和专用摄像头 zip 已重新生成。
- 备份旧应用后更新 /Applications/SoundFace.app，安装版 app.asar 和图标与专用构建一致。真实 Finder 预览与工作台侧栏均已显示新图标；证据 build/soundface-icon-finder.png / build/soundface-icon-installed.png / build/icon-install-verification.json。应用保持运行，所有音视频采集及云端会话均未开启；未产生新的数字人费用。本轮仅验证图标、打包与显示，未重复音视频链路验收。


## 2026-11-26 首页虚拟摄像头交互

- 大预览保留，真实摄像头只在右下小窗；主卡片统一为“开启虚拟摄像头”，登录后自动继续开启，角色选择跨重启保存。直播窗口、测试画面、声音及排查信息移入默认折叠的“高级”。停止需确认，停止未确认时保留重试入口；录制入口放在预览下方，未出画面时禁用（免费测试画面除外）。低余额提醒不覆盖已有错误。
- `npm test` 全部通过：62 项 JS/桥接测试，以及原生摄像头、帧解码、音频 ring 和重采样测试。
- 真实 Electron + 本地 fake Workers：登录后进入 creating，无需第二次点击；免费测试画面经原生组件送入摄像头，停止确认取消后继续输出、确认后停止。真实本机摄像头小窗验证通过。截图在 /private/tmp/claude-501/sf/v4-shots/。运行中数字人卡片、余额提醒和停止重试使用注入状态验证，非真实云端生成。
- 按用户决定未安装或测试 OBS；未新建付费云端会话。


## 2026-11-26 虚拟摄像头帧率修复

- 取消渲染端 15 fps 瓶颈，改为 30 fps 上限（2 ms 回调抖动容差），保留单帧在途、250 ms 过期、会话令牌和隐私保护；免费测试源默认改为 30 fps。现有 JPEG 编码和 IPC 实测平均约 9 ms / 5 ms，因此这次达到 18–19 fps 不需要重写原始像素传输。
- 本机真实 Electron → 原生 bridge → SoundFace Camera → ffmpeg AVFoundation 1280×720/30fps 采集，用画面下方帧号与运动区域 `crop=1000:170:50:490,mpdecimate` 去除重复帧。证据保存在 build/fps-review/（不入库）。
- 同一个 15 fps 免费测试源：修前 8 秒内 85 个不同画面（约 10.6 fps），修后 8 秒内 122 个（约 15 fps，存在采集边界误差）。模拟云端 19 fps 的测试源，10 秒内 189 个不同画面（约 18.9 fps）。30 fps 测试源同法得约 19.5 fps，因此不宣称稳定 30 fps。
- 停止后直接采集摄像头，已回到原生隐私占位画面，无残留测试画面。15 项帧传输、停止/隐私取消和合成测试通过，新增 19 fps 保帧及 60 fps 限速回归测试。
- 以上是免费本地合成画面的真实摄像头链路验证；未测当前真实云端生成帧率、付费会话或 OBS。


## 2026-11-26 管理后台（本地验证，尚未部署）

- `admin/` 提供概览、兑换码生成/下载/查询/作废、用户列表/详情、加减分钟、使用统计及操作记录。每个 `/admin/v1/` 请求都校验邮箱名单；手机号和开发账号即使写入名单也不能进入。完整兑换码只在生成时展示一次，数据库仅存哈希及尾号。
- D1 新增用户汇总、余额流水、会话记录和审计表，DO 仍为余额权威源；DO 本地事务保存 outbox，alarm 退避重试，幂等写入防止重复。老账号自动回填，也提供手动回填。跨午夜会话整段归开始日（北京时间）。兑换码作废和对应审计在同一个 D1 batch 事务中提交。
- `cd workers && npm test`：19 项 workerd + 本地 D1 + DO 测试全部通过。其中 13 项后台测试覆盖权限、500 个批量生成、已兑换/作废/过期状态、余额边界、统计对账与跨日规则、D1 故障重试、回填、只读审计、异常日期和审计写失败时作废回滚。测试串行运行，显式 fake provider 和禁付费。
- `node --test tests/*.test.cjs`：63 项客户端/桥接测试全部通过。客户端充值记录支持“后台调整”和负数分钟。
- Playwright 实际浏览器：开发邮箱验证码登录、生成两张 99 分钟码、下载 CSV（核对表头和两条记录）、批次作废确认、用户详情加 3 分钟（10→13）以及对应审计记录均验证通过；概览、使用统计可打开。截图在 output/playwright/admin-*.png（不入库）。
- 生产尚未应用 0002_admin.sql，也未部署 admin.dot.cc；上线需要管理员邮箱及单独部署授权。操作步骤见 workers/README.md。以上测试均未真实发信或创建付费数字人。
