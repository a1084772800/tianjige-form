# 部署 save_render P0 安全修复（2026-05-04 心脏 opus 体检）

## 现状
- 代码已修复 + 提交：commit e500b0d
- `render.html` 已 push 到 GitHub Pages，自动部署完成（iframe sandbox 收紧 + postMessage 桥接）
- `laf_save_render.ts` 待部署到 Laf（PAT 已失效，需要 owner 给 fresh PAT 再跑）
- `RENDER_SAVE_TOKEN` 已生成并写入 `~/.env`：`3ydcdPZtblACeqarJTSmOGUmv_j_Bkmrmfw1AcZRD50`

## owner 端三步部署

### 1. 拿 fresh PAT
登 https://hzh.sealos.run → 右上角头像 → 个人中心 → API Key → 创建 PAT。

### 2. 替换 ~/.env 里的 LAF_PAT
```bash
# 把 LAF_PAT=laf_Ki8...AQXTddTKVUhN 改成新 PAT
vim ~/.env
```

### 3. 部署 save_render（带 RENDER_SAVE_TOKEN env）
Sealos web → 应用管理 → v609a76lof → save_render 函数 →
**编辑环境变量**：新增 `RENDER_SAVE_TOKEN=3ydcdPZtblACeqarJTSmOGUmv_j_Bkmrmfw1AcZRD50`
（必须在云函数侧设置，否则函数会拒所有请求）

然后部署代码：
```bash
python3 ~/.workspace/tianjige/scripts/laf_deploy.py save_render
```

### 4. 验证
```bash
# 注入应被拒（unauthorized 或 xss_blocked）
curl -sS -X POST 'https://v609a76lof.sealoshzh.site/save_render' \
  -H 'Content-Type: application/json' \
  -d '{"render_id":"_xss_after","html":"<script>top.location=\"//evil.com\"</script>"}'

# 合法请求应成功
RENDER_SAVE_TOKEN=$(grep RENDER_SAVE_TOKEN ~/.env | cut -d= -f2)
curl -sS -X POST 'https://v609a76lof.sealoshzh.site/save_render' \
  -H 'Content-Type: application/json' \
  -H "X-Save-Token: $RENDER_SAVE_TOKEN" \
  -d '{"render_id":"_post_fix_ok","html":"<h1>合法 hello</h1>","expires_in":1}'

# render_tool save 走自动带 header
echo '<h1>render_tool 测试</h1>' | python3 ~/.workspace/shared/scripts/render_tool.py save _post_fix_render_tool_ok -
```
