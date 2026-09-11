// electron-builder 只在完整 pack 流程里通过 onAfterPack 写入
// resources/app-update.yml(见 app-builder-lib PublishManager);本仓库用
// electron-forge 先打包、electron-builder --prepackaged 只做安装包,该模式下
// doPack 直接 return,app-update.yml 会缺失,electron-updater 运行时将找不到
// 更新配置。本脚本在 forge package 之后、electron-builder 之前补写同样内容的
// app-update.yml(字段与 PublishManager.getAppUpdatePublishConfiguration 一致)。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import YAML from 'yaml';

const require = createRequire(import.meta.url);

/** 与 app-builder-lib 同一实现(builder-util sanitizeFileName),失败时退化为内联规则。 */
function sanitizeFileName(name) {
  try {
    return require('builder-util/out/filename.js').sanitizeFileName(name);
  } catch {
    return name.replace(/[/\\?%*:|"<>]/g, '').replace(/[. ]+$/, '');
  }
}

const appDir = process.argv[2];
if (!appDir) {
  console.error('usage: node scripts/write-app-update-yml.mjs <packaged-app-dir>');
  process.exit(1);
}

/** Windows/Linux:<appDir>/resources;macOS:<appDir>/<Product>.app/Contents/Resources */
function resolveResourcesDir(dir) {
  const direct = path.join(dir, 'resources');
  if (fs.existsSync(direct)) return direct;
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith('.app')) {
        const candidate = path.join(dir, entry, 'Contents', 'Resources');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error(`resources directory not found under ${dir} — run electron-forge package first`);
}

const builderConfig = YAML.parse(fs.readFileSync(path.resolve('electron-builder.yml'), 'utf8'));
const publish = Array.isArray(builderConfig.publish) ? builderConfig.publish[0] : builderConfig.publish;
if (!publish || publish.provider !== 'generic' || typeof publish.url !== 'string') {
  throw new Error('electron-builder.yml 缺少 publish generic 配置(provider/url)');
}

const productName = typeof builderConfig.productName === 'string' ? builderConfig.productName : 'Vesti';
const appUpdateYml = {
  provider: 'generic',
  url: publish.url,
  channel: typeof publish.channel === 'string' ? publish.channel : 'latest',
  updaterCacheDirName: `${sanitizeFileName(productName).toLowerCase()}-updater`,
};

const resourcesDir = resolveResourcesDir(appDir);
const target = path.join(resourcesDir, 'app-update.yml');
fs.writeFileSync(target, YAML.stringify(appUpdateYml), 'utf8');
console.log(`[app-update] wrote ${target}`);
