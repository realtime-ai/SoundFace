# 默认角色「青禾」

`default-character.png` 是 AI 生成的原创虚构成年角色参考图；`default-character.jpg` 是用于应用和后续接口的压缩版本。不是用户照片，也不是授权克隆某个真人的模板。

生成说明：约 28 岁、东亚外观、中性气质、短深色头发、鼠尾草绿色上衣、正面摄影棚肖像、中性灰背景、清晰面部、无文字与配饰。

默认图用于角色卡片预览，并在用户开启数字人时作为 `subject_replacement` 参考图上传。角色卡片始终是静态素材；只有收到云端视频帧，主预览才标记为实时生成。生成画面已接入 SoundFace Camera，并通过腾讯会议本机采集验证。

青禾是 SoundFace 自有默认参考素材，不是 API 平台的官方模板。自定义角色通过原生选择器导入，参考图副本与缩略图保存在应用 userData，不随源码或安装包分发。

## 应用图标

`icons/soundface-source.png` 是内置图像生成工具制作的图标母版：深森林绿底、薄荷绿人脸轮廓与三段声波，透明外边距，无字母。`node scripts/build-icon.cjs` 使用 macOS sips / iconutil 从母版生成 1024 px 的 `icons/soundface.png` 和含 16–1024 px 尺寸的 `icons/SoundFace.icns`；打包脚本自动执行。PNG 用于工作台与开发 Dock，ICNS 用于正式应用包的 Finder / Dock 图标。母版不直接装入应用。

生成方式：built-in image_gen，transparent_background=true。最终提示词：

```text
Use case: logo-brand.
Asset type: final macOS application icon for SoundFace, an app for real-time virtual faces and virtual microphones.
Create ONE beautifully crafted, memorable icon, not a presentation, not a mockup. Square 1024x1024 composition, transparent outside a large rounded-square macOS icon tile. Tile occupies about 86% of the canvas, centered, with smoothly rounded corners and a restrained soft shadow.
Primary symbol: a single bold mint-green abstract human face/voice monogram, combining a smooth open face outline with three rounded vertical audio-wave bars. The right contour suggests a human forehead, nose and chin, the bars on the left imply a voice. One small simple eye detail. Make the negative space elegant, readable and distinctive. Keep the symbol geometric, friendly, balanced, with very few elements. It should remain identifiable at 32 pixels. Avoid a literal microphone, camera illustration, robot, theatrical masks or emoji.
Tile color: very dark forest green #172d24 with extremely subtle satin depth. Symbol: vivid mint #5fd49a with a gentle lighter mint highlight, almost flat, precise edges. Premium native Mac utility aesthetic, restrained dimensionality, no heavy bevels, no glossy plastic, no decorative particles. Large central mark with generous breathing room. Front-facing, perfectly square to the viewer, no perspective.
No letters, no words, no captions, no watermark, no collage, no alternative icons, no border around the overall canvas. Actual transparent outer background.
```
