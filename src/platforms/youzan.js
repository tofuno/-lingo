import { makeActions } from "./common.js";

export const meta = { id: "youzan", name: "有赞" };

export const profile = {
  id: "youzan",
  name: "有赞",
  buyable: /立即购买|立即预约|马上抢|去预约|立即抢购|加入购物车/,
  rest: /休息中|暂停接单|暂时休息|已结束|未开始/,
  buy: /立即购买|立即预约|马上抢|去预约|立即抢购/,
  submit: /提交订单|确认订单|去结算/,
  pay: /立即支付|确认支付|微信支付|支付宝/,
};

export default makeActions(profile);
