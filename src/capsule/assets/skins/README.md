# 悬浮球猫头鹰皮肤素材

每个子目录是一套皮肤，内含 `collapsed.png`（1024×1024 RGBA，透明背景，四角 alpha=0），
即悬浮球折叠态的猫头鹰圆球立绘。皮肤在 `src/capsule/skins.ts` 注册，选择结果存于
ui-prefs 的 `owlSkin`。

## 素材来源与重新生成

素材由仓库外的脚本批量生成：`C:/Users/22150/小蜂相关资料/绘图/generate_vesti_owl_skins.py`
（gpt-image-2-high I2I，以品牌 logo 为参考图；生成后自动抠白底、归一化到 1024×1024
并直接写入本目录）。

```bash
# WSL 中运行：
cd /mnt/c/Users/22150/小蜂相关资料/绘图 && PYTHONPATH=./.deps python3 generate_vesti_owl_skins.py
```

- 统一风格前缀在脚本的 `STYLE` 常量里（圆球构图、纯白底、保留猫头鹰识别特征），
  批量出变体时请原样复用该前缀，只改各皮肤的 `Skin:` 指令段。
- 新增皮肤：在脚本的 `SKINS` 字典加条目并运行，产物落到 `assets/skins/<id>/collapsed.png`，
  再在 `src/capsule/skins.ts` 的 `SKINS` 数组注册（id、中英文名称）即可，
  设置页选择器与胶囊渲染会自动生效。
