import { makeActions } from "./common.js";

export const meta = { id: "maoyan", name: "猫眼" };

export const profile = {
  id: "maoyan",
  name: "猫眼",
  buyable: /立即购票|选座购票|立即购买|立即预订|马上购票/,
  rest: /已结束|未开始|售罄|暂无余票|无票|已停售/,
  buy: /立即购票|选座购票|立即购买|立即预订/,
  submit: /提交订单|确认订单|去支付|去结算/,
  pay: /立即支付|确认支付|支付宝|微信/,
};

export default makeActions(profile);
