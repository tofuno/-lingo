import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* 可写目录
 * 打包成 exe 后，程序目录（root）是只读的：配置与登录态必须写到用户目录。
 * Electron 主进程会传 LINGO_DATA_DIR = app.getPath("userData")。
 * 开发态不传，行为与以前完全一致（配置在 src/config.json，数据在 ./data）。 */
const override = process.env.LINGO_DATA_DIR ? path.resolve(process.env.LINGO_DATA_DIR) : null;
const configDir = override || path.join(root, "src");
const dataDir = override || root;

fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const CONFIG = path.join(configDir, "config.json");
const EXAMPLE = path.join(root, "src", "config.example.json");

export function loadConfig() {
  if (!fs.existsSync(CONFIG)) {
    if (!fs.existsSync(EXAMPLE)) throw new Error("缺少 config.json / config.example.json");
    fs.copyFileSync(EXAMPLE, CONFIG);
    console.log(`[config] 已从示例创建 ${CONFIG}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), "utf8");
}

export const paths = { root, configDir, dataDir, config: CONFIG };
export function dataPath(rel) {
  return path.isAbsolute(rel) ? rel : path.join(dataDir, rel);
}
