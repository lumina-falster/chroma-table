# 发布到 GitHub

建议公开仓库名称：chroma-table，展示名：染域 CHROMA。

若暂时无法自动发布：登录 GitHub，新建一个 Public 仓库，仓库名填 chroma-table，不勾选初始化 README。随后在本目录执行：

```sh
git init -b main
git add .
git commit -m "Prepare Chroma Table source"
git remote add origin https://github.com/YOUR_USERNAME/chroma-table.git
git push -u origin main
```

把 YOUR_USERNAME 替换成自己的 GitHub 用户名。Git 的账号验证请在 GitHub 官方登录或设备授权页面完成，不要把密码或个人 Token 提交到仓库。

本项目仅上传公开源码；不创建 Release，不创建版本标签，也不启用 GitHub Pages 或其他网站部署。推送成功后，朋友可在仓库页面选择 Code → Download ZIP。
