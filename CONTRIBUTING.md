# 贡献说明

欢迎通过 Issue 提交问题，通过 Pull Request 提交改进。

1. Fork 仓库并创建修改分支。
2. 使用 Node.js 22.8+，运行 node server.js。
3. 修改后运行 node --test --test-isolation=none test/*.test.js。
4. 在 PR 中说明触发问题的步骤、修改后的行为和验证结果。

规则改动需覆盖多人轮次、费用和边界情况；联机改动需验证玩家、观众、断线和重连。请保留 app.js 中教程与同步逻辑的边界标记，相关测试直接运行与浏览器相同的模型。

请勿提交个人令牌、账号凭据、运行日志、node_modules 或来源许可不明的图片。新增素材应说明来源和许可。
