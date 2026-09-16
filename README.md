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

1. 仓库 **Settings → Pages**
2. Source 选 **Deploy from a branch**
3. Branch 选 **main**，目录选 **/ (root)**，Save
4. 等 1 分钟左右，访问 `https://klb203.github.io/tidal-echo-web/`

> `.nojekyll` 已经在仓库里了，防止 GitHub 的 Jekyll 处理干扰静态文件。

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
