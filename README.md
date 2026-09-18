# Tidal Echo · Web

Tidal Echo 的前端：一个单文件 PWA 聊天壳，纯静态，直接扔到 GitHub Pages 就能用。

配套后端 → [klb203/tidal-echo-relay](https://github.com/klb203/tidal-echo-relay)

---

## 这是什么 / 为什么要有后端

前端本身只是个界面。它要说话就得调用大模型接口，而**浏览器的同源策略（CORS）不允许网页直接请求
DeepSeek / 硅基流动 / 智谱 / Kimi 这些接口**（只有 DeepSeek 放行）。所以必须有一个中间人：

```
浏览器 ──► 你的后端（tidal-echo-relay）──► DeepSeek / 硅基流动 / 智谱 / Kimi
       同源，不受限                     服务器之间没有 CORS
```

后端已经部署好了吗？没有的话先去做 → [relay 仓库的说明](https://github.com/klb203/tidal-echo-relay)

---

## 部署到 GitHub Pages

**已启用**，线上地址 → <https://klb203.github.io/tidal-echo-web/>

仓库 Settings → Pages 的当前配置（供重装或换仓库时参考）：

1. Source 选 **Deploy from a branch**
2. Branch 选 **main**，目录选 **/ (root)**，Save
3. 等 1 分钟左右即可访问

> `.nojekyll` 已经在仓库里了，防止 GitHub 的 Jekyll 处理干扰静态文件。

### 为什么国内推荐把 GitHub Pages 当主入口

实测（2026-09，从国内网络**不走任何代理**直连）：

| 目标 | 结果 |
|---|---|
| `klb203.github.io/tidal-echo-web/` 全部 17 个 URL | 全部 200 |
| `index.html`（771 KB）首次加载 | **0.51 秒** |
| 对比：`*.vercel.app` | **完全不可达** |

GitHub Pages 在国内属于「半可用」——大城市的宽带和移动网络基本能直连，
但二三线城市、校园网和部分运营商可能变慢或打不开（GitHub 走的是境外 CDN，
节点覆盖不均衡）。`*.vercel.app` 则是整体不可用。

所以建议：**GitHub Pages 当国内主入口，Vercel 留着做备份 / 桌面端**。
两边内容完全一样，一次 push 同时更新。

> HTTPS 是强制开启的，所以 Service Worker、离线缓存、锁屏推送、装到主屏都可用。
> 想要 100% 稳定的国内访问，只有「自有服务器 + 备案域名」这一条路，
> 免费方案做不到（免备案就拿不到大陆节点，这是规则不是平台问题）。

---

## 部署到 Vercel（并让国内手机不用代理也能打开）

### 1. 导入项目

Vercel → **Add New → Project** → 选这个仓库 → Import。
**Framework Preset 必须选 `Other`**，Build Command / Output Directory / Install Command 全部留空。

> 本仓库是纯静态、**没有构建步骤**。如果你在 Vercel 里选了 **Vite**，它会去找
> `npm run build` 和 `dist/` —— 两者都不存在，轻则部署失败，重则部署"成功"但整站 404。
> 仓库里的 `vercel.json` 已经把 `framework` 钉成 `Other`、输出目录钉成仓库根，
> 所以即使之前选错过，推一次代码就会自动纠正。

### 2. `vercel.app` 在国内打不开 —— 这是 DNS 污染，不是代码问题

`xxx.vercel.app` 这个域名在国内被污染，且 Vercel 的边缘节点不在大陆。
**唯一的正解是绑一个你自己的域名**（不需要备案，证书 Vercel 会自动签发）。

1. Vercel → 项目 → **Settings → Domains** → 填 `www.你的域名.com` → Add
2. 它会让你配一条 DNS 记录。**先别照抄它给的默认值**，回到域名服务商（阿里云 / 腾讯云 / Cloudflare）
   按下面配：

   | 类型 | 主机记录 | 记录值 | 说明 |
   |---|---|---|---|
   | CNAME | `www` | `cname-china.vercel-dns.com` | **关键**：Vercel 的大陆优化节点。默认的 `cname.vercel-dns.com` 国内不稳 |
   | A | `@` | `76.227.212.86` | 只有想用裸域名访问才需要（Vercel 默认的 `76.76.21.21` 国内基本不通） |

3. 等 1~5 分钟，Vercel 的 Domains 页变成绿色 Valid Configuration，证书自动签发。

**走 Cloudflare 的话**：CNAME 先保持**灰云（DNS only）**让 Vercel 验证通过 ——
橙云代理会让 Vercel 看不到 CNAME、一直验证失败，验证过了再决定要不要开。
另外 Cloudflare 的 SSL/TLS 模式必须选 **完全（Full）**，选「灵活」会报 526。

**目标效果**：手机 4G/5G 直接打开 `https://www.你的域名.com`，不需要任何代理 / 节点。

### 3. 缓存与更新（改前端必读）

`vercel.json` 已经做了三件事，都是为了让「装到主屏的 App」能及时更新：

- `sw.js` 强制 `Cache-Control: no-cache` —— 否则 Vercel 的 CDN 会把旧 Service Worker
  缓存住，手机上会永远停在旧壳；
- `index.html` / `album.html` / `galaxy.html` 每次回源校验，不缓存；
- `.webmanifest` 用正确的 `Content-Type: application/manifest+json`。

改完前端照旧要 **bump `sw.js` 顶部的 `CACHE`**，两件事缺一不可。

### 4. 备选：不想折腾域名

把这几个文件整个丢到你自己的 VPS（nginx 指向它）也一样免代理 —— 而且和后端**同源**，
设置里「云端后端」可以直接留空走相对路径 `/relay`，连跨域都省了。

> **注意仓库里必须有这些文件**，少一个就会 404 / 白屏：
> `index.html` `album.html` `galaxy.html` `sw.js` `manifest.webmanifest`
> `favicon.png` `apple-touch-icon.png` `icon-192.png` `icon-512.png`
> `avatar-sea.png` `chat-light.webp` `chat-harbor.webp` `menu-light.webp`
> `menu-harbor.webp` `send.mp3` `al-board.png`

---

## 第一次使用（三步）

**1. 填后端地址**
打开 App → 左下角菜单 → **设置** → 最上面「**云端后端**」→ 填你部署好的地址，例如
`https://tidal-echo-relay-1-vudb.onrender.com`（换成你自己的），点别处让它保存。
下面的状态条会变成「当前后端：…」，就说明生效了。点旁边的 **「测试后端连接」** 可以当场验证通不通。

**2. 加一个连接**
同页面往下 → **添加连接** →
- 类型：`模型直连（OpenAI 兼容，多家云模型）`
- 名称：随便，比如「DeepSeek」
- 供应商：选 **`☁ 云端 · DeepSeek`**（硅基流动 / 智谱 GLM / Kimi 同理）
- API Key：填你自己的 key
- 模型：点「拉取模型」会自动列出，也可以手填
- 点 **保存并使用**

**3. 开始聊**

四家的云端入口分别是：

| 选哪个 | 后端实际请求的地址 |
|---|---|
| ☁ 云端 · DeepSeek | `https://你的后端/relay/deepseek/v1/chat/completions` |
| ☁ 云端 · 硅基流动 | `https://你的后端/relay/siliconflow/v1/chat/completions` |
| ☁ 云端 · 智谱 GLM | `https://你的后端/relay/zhipu/v4/chat/completions` |
| ☁ 云端 · Kimi | `https://你的后端/relay/moonshot/v1/chat/completions` |

---

## Key 放哪

**默认（推荐）：放在 App 里。** 填在「连接 → API Key」，只存在你这台设备的 localStorage，
后端只是帮你转发一下。别人发现你的后端地址也没关系，他们得用**自己的** Key。

**另一种：放在后端的环境变量里。** 这样 App 里 Key 留空也能用，换设备不用重填。
但你的后端地址是公开的，**务必同时给后端设一个 `RELAY_TOKEN`**，然后在 App 的
「设置 → 云端后端 → 访问令牌」填同样的字符串。

---

## 本地预览（可选）

```bash
python -m http.server 5500
# → http://127.0.0.1:5500
```

---

## 常见问题

**拉模型报 `TypeError: Failed to fetch`？**
说明这家不放行浏览器直连。选 **☁ 云端** 那组供应商，别用「浏览器直连」那组。

**提示「还没设置云端后端地址」？**
设置 → 云端后端 → 填地址。改一次，所有云连接会一起跟着更新。

**第一次发消息特别慢（30~50 秒）？**
Render 免费档 15 分钟没人访问会休眠，第一下是冷启动。之后就快了。
想彻底不休眠，用后端仓库里的 `worker/worker.js` 部署到 Cloudflare Workers。

**后端返回 401？**
后端和 App 里都没配这家 Key。至少填一个。

**返回「连不上上游 …」？**
后端所在的服务器访问不了那家接口（少见，通常是那家自己抽风）。看看后端的状态页有没有报错。

**Vercel 上打开是 `404: NOT_FOUND`？**
Framework Preset 被选成了 `Vite`，它在找不存在的 `dist/`。改成 `Other`（或直接推一次代码，
`vercel.json` 会自动纠正）。

**手机 4G 打不开，连 Wi-Fi 却正常？**
`vercel.app` 被污染了，绑自定义域名，见上面的「部署到 Vercel」一节。

**装到主屏后界面一直是旧版？**
没有 bump `sw.js` 里的 `CACHE`。改完前端把 `companion-vN-xxx` 的版本号加一 ——
不 bump 的话预缓存的旧 `index.html` 不会被替换掉。

**壁纸 / 头像不见了，只剩一片渐变？**
说明 `chat-*.webp` / `menu-*.webp` / `avatar-sea.png` 没在仓库里。
页面有内联矢量兜底所以不会破图，但那只是"看起来不太空"而已 —— 把图传上去就好了。
