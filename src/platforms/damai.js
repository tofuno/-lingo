import { makeActions } from "./common.js";

export const meta = { id: "damai", name: "大麦" };

export const profile = {
  id: "damai",
  name: "大麦",
  buyable: /立即购买|选座购买|立即预订|立即抢购|缺货登记|预约购票/,
  rest: /已结束|未开始|售罄|缺货|暂停销售|无票|已下架/,
  buy: /立即购买|选座购买|立即预订|立即抢购/,
  submit: /提交订单|确认订单|去结算|下一步/,
  pay: /立即支付|确认支付|支付宝|微信支付/,
};

export default makeActions(profile);
