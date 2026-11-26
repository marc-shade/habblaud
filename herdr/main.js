import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, run, spaces } from "herdr";

const office = "http://127.0.0.1:4747";
const fleet = "http://127.0.0.1:4749";
const providers = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" };

async function read(url) {
  const reply = await exec("/usr/bin/curl", ["--noproxy", "*", "-fsS", "--max-time", "4", url]);
  if (reply.code !== 0) throw new Error(reply.stderr.trim() || "Service unavailable");
  return JSON.parse(reply.stdout);
}

function button(id, label, click, selected = false) {
  return div().id(id).rounded(5).px(10).py(6).cursor_pointer()
    .bg(selected ? "#285548" : "#24333c").hover(s => s.bg("#36505b"))
    .on_click((_event, cx) => click(cx)).child(label);
}

export default class Habblaud extends View {
  init(_props, cx) {
    this.node = "mbp-max";
    this.refresh(cx);
    cx.timer.every(5000, cx => this.refresh(cx));
  }
  refresh(cx) {
    if (this.polling) return;
    this.polling = true;
    cx.spawn(async cx => {
      try {
        const [cluster, local, requests] = await Promise.allSettled([
          read(fleet + "/api/snapshot"), read(office + "/api/health"), read(office + "/api/mod/summary"),
        ]);
        this.snapshot = cluster.status === "fulfilled" ? cluster.value : null;
        this.health = local.status === "fulfilled" ? local.value : null;
        this.waiting = requests.status === "fulfilled" ? requests.value.waiting : null;
        this.errors = [cluster, local, requests].map((r, i) => r.status === "rejected"
          ? (["Fleet office: ", "Local office: ", "Review requests: "][i]) + String(r.reason) : "").filter(Boolean);
      } finally {
        this.polling = false;
        cx.notify();
      }
    });
  }
  open(url, cx) {
    cx.spawn(async cx => {
      try {
        const result = await exec("/usr/bin/open", [url]);
        this.openError = result.code ? result.stderr.trim() || "Could not open browser" : "";
      } catch (e) { this.openError = String(e); }
      cx.notify();
    });
  }
  render() {
    const rows = this.snapshot?.nodes || [];
    const node = rows.find(n => n.name === this.node);
    const agents = (this.snapshot?.agents || []).filter(a => a.id.startsWith(this.node + ":"));
    const rooms = new Map((this.snapshot?.rooms || []).map(r => [r.id, r.name]));
    const section = label => div().mt(9).text_color("#90d6b6").font_semibold().child(label);
    const workspaces = spaces().filter(s => (s.machine || "mbp-max") === this.node);
    const actions = h_flex().gap(8).flex_wrap()
      .child(button("office", "Open full local office", cx => this.open(office + "/?lang=en", cx)))
      .child(button("fleet", "Open fleet canvas", cx => this.open(fleet + "/?lang=en", cx)))
      .child(button("refresh", "Refresh", cx => this.refresh(cx)));
    const panel = v_flex().id("habblaud-office").size_full().min_h(0).overflow_y_scroll()
      .p(18).gap(9).bg("#121c22").text_color("#e3edea")
      .child(div().text_size(23).font_semibold().child("Habblaud"))
      .child(div().child(rows.length ? rows.filter(n => n.state === "online").length + "/" + rows.length + " nodes online" : "Waiting for the fleet office"))
      .child(actions);
    if (this.health) {
      const enabled = ["terminal", "permissions", "pty", "messages", "codexEvents"].filter(k => this.health[k]);
      panel.child(div().child("Local server " + this.health.version + " · " + enabled.map(k => ({pty:"interactive terminal",codexEvents:"Codex events"}[k] || k)).join(", ")));
    }
    for (const error of [...(this.errors || []), this.openError].filter(Boolean)) panel.child(div().text_color("#edb397").child(error));
    if (this.waiting?.length) {
      panel.child(section("Waiting for you · local office"));
      for (const request of this.waiting) {
        const label = [request.name, request.room, request.waitingFor].filter(Boolean).join(" · ");
        panel.child(button("review-" + request.id, label, cx => this.open(office + "/?lang=en&agent=" + encodeURIComponent(request.id), cx)));
      }
    }
    panel.child(section("Nodes")).child(h_flex().flex_wrap().gap(6).children(rows.map(n =>
      button("node-" + n.name, n.name + " · " + n.state, cx => { this.node = n.name; cx.notify(); }, n.name === this.node))));
    if (!node) return panel;
    panel.child(section("Session sources")).child(div().child(node.sources.map(s =>
      (providers[s.provider] || s.provider) + (s.ok ? " · available" : " · unavailable")).join("     ") || node.state));
    panel.child(section("Sessions · " + agents.length));
    for (const agent of agents) {
      const label = [agent.name, providers[agent.provider] || agent.provider, rooms.get(agent.roomId), agent.status].filter(Boolean).join(" · ");
      panel.child(button("agent-" + agent.id, label, cx => this.open(fleet + "/?lang=en&agent=" + encodeURIComponent(agent.id), cx)));
    }
    if (!agents.length && node.state === "online") panel.child(div().child("No current sessions"));
    if (workspaces.length) panel.child(section("Herdr workspaces")).child(h_flex().gap(6).flex_wrap().children(workspaces.map(s =>
      button("space-" + s.id, s.name, () => run("space.select", {id:s.id})))));
    return panel;
  }
}
