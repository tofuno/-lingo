import { makeActions } from "./common.js";

export const meta = { id: "taopiaopiao", name: "淘票票" };

export const profile = {
  id: "taopiaopiao",
  name: "淘票票",
  buyable: /立即购票|选座购票|立即购买|特惠购票|马上购票/,
  rest: /已结束|未开始|售罄|暂无余票|无票|已停售/,
  buy: /立即购票|选座购票|立即购买|特惠购票/,
  submit: /提交订单|确认订单|去支付|去结算/,
  pay: /立即支付|确认支付|支付宝|花呗/,
};

export default makeActions(profile);
