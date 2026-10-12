import { makeActions } from "./common.js";

export const meta = { id: "binwan", name: "缤玩岛" };

export const profile = {
  id: "binwan",
  name: "缤玩岛",
  buyable: /立即购票|立即购买|马上抢购|选座购票|立即预订/,
  rest: /已结束|未开始|售罄|无票|已停售|暂无余票/,
  buy: /立即购票|立即购买|马上抢购|选座购票/,
  submit: /提交订单|确认订单|去支付|去结算/,
  pay: /立即支付|确认支付|微信支付|支付宝/,
};

export default makeActions(profile);
