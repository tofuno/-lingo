import youzan from "./youzan.js";
import damai from "./damai.js";
import maoyan from "./maoyan.js";
import taopiaopiao from "./taopiaopiao.js";
import binwan from "./binwan.js";

export const platforms = { youzan, damai, maoyan, taopiaopiao, binwan };

export function getPlatform(id) {
  return platforms[id] || youzan;
}

export const platformIds = Object.keys(platforms);
