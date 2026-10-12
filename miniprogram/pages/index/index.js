const app = getApp();

Page({
  data: {
    base: "",
    running: false,
    mode: "monitor",
    platform: "youzan",
    accounts: 0,
    targets: 0
  },
  onLoad() {
    this.setData({ base: app.globalData.apiBase });
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 3000);
  },
  onUnload() { if (this.timer) clearInterval(this.timer); },

  req(path, opts = {}) {
    return new Promise((resolve) => {
      wx.request({
        url: app.globalData.apiBase + path,
        method: opts.method || "GET",
        data: opts.data,
        success: (r) => resolve(r.data),
        fail: () => resolve(null)
      });
    });
  },

  async refresh() {
    const s = await this.req("/api/status");
    if (s) this.setData({ running: !!s.running });
    const c = await this.req("/api/config");
    if (c) {
      this.setData({
        mode: c.mode || "monitor",
        platform: c.platform || "youzan",
        accounts: (c.accounts || []).length,
        targets: (c.targets || []).length
      });
    }
  },

  start() { this.act("/api/start", "已启动"); },
  stop() { this.act("/api/stop", "已暂停"); },

  async act(path, okMsg) {
    wx.showLoading({ title: "处理中" });
    const r = await this.req(path, { method: "POST" });
    wx.hideLoading();
    wx.showToast({ title: r ? okMsg : "请求失败", icon: r ? "success" : "none" });
    this.refresh();
  },

  async setMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({ mode });
    await this.req("/api/config", { method: "POST", data: { mode } });
    this.refresh();
  }
});
