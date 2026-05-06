---
title: 用 Docker Compose 搭建本地开发环境
date: 2026-02-28
tags: [Docker, DevOps, 工程化]
description: 通过实际项目案例，演示如何用 Docker Compose 统一管理前后端与数据库的本地环境，告别"在我机器上能跑"的问题。
read-time: 约 6 分钟
---

## 为什么需要 Docker Compose

本地开发环境的经典困境是：项目跑通了，换台机器就崩了。原因通常是 Python 版本不对、数据库没起、环境变量漏配，或者某个依赖装了全局又和另一个项目冲突。

Docker Compose 把这些问题收进一个 `compose.yml`，任何人拉下仓库，执行一行命令，就能得到完全一致的本地环境。

## 项目结构

以一个前后端分离项目为例，结构如下：

```
my-project/
├── compose.yml          # 编排文件
├── backend/             # FastAPI 服务
│   ├── Dockerfile
│   ├── main.py
│   └── requirements.txt
├── frontend/            # Vue 3 应用
│   ├── Dockerfile
│   └── src/
└── .env                 # 环境变量（不提交 git）
```

## 编写 compose.yml

```yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-mydb}
      POSTGRES_USER: ${POSTGRES_USER:-dev}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-devpass}
    volumes:
      - pg_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  backend:
    build: ./backend
    restart: unless-stopped
    depends_on:
      - db
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-dev}:${POSTGRES_PASSWORD:-devpass}@db:5432/${POSTGRES_DB:-mydb}
    ports:
      - "8000:8000"
    volumes:
      - ./backend:/app   # 挂载源码，支持热重载

  frontend:
    build: ./frontend
    restart: unless-stopped
    depends_on:
      - backend
    ports:
      - "5173:5173"
    volumes:
      - ./frontend:/app
      - /app/node_modules  # 避免覆盖容器内的 node_modules

volumes:
  pg_data:
```

几个关键点：

- `depends_on` 只保证启动顺序，不保证服务就绪。如果 backend 启动时 db 还没完成初始化，需要在代码里加重试逻辑或用 `healthcheck`。
- `volumes` 把源码目录挂进容器，改代码后不需要重新 build，配合 FastAPI 的 `--reload` 和 Vite 的 HMR 即可热更新。
- 环境变量用 `${VAR:-default}` 语法提供默认值，`.env` 文件里覆盖即可，不影响 compose.yml 本身。

## Backend Dockerfile

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
```

> `--reload` 配合挂载的 volume，修改 Python 文件后 uvicorn 会自动重启，无需重新 build。

## Frontend Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
```

`--host 0.0.0.0` 让 Vite 监听所有网卡，否则容器内启动的服务从宿主机无法访问。

## 常用命令

```bash
# 首次启动（构建镜像 + 启动所有服务）
docker compose up --build

# 后台运行
docker compose up -d

# 查看日志
docker compose logs -f backend

# 只重启某个服务
docker compose restart backend

# 停止并删除容器（保留 volume 数据）
docker compose down

# 连同 volume 一起清除（慎用，会删数据库数据）
docker compose down -v
```

## 处理数据库迁移

启动时自动跑迁移是个常见需求。可以在 compose.yml 里用 `command` 覆盖启动命令：

```yaml
backend:
  command: >
    sh -c "alembic upgrade head &&
           uvicorn main:app --host 0.0.0.0 --port 8000 --reload"
```

或者单独写一个迁移 service，用 `depends_on` + `healthcheck` 保证顺序。

## 多环境区分

本地开发和 CI 环境可能配置不同，用 override 文件分层覆盖：

```
compose.yml           # 基础配置（共享）
compose.override.yml  # 本地开发（自动加载）
compose.ci.yml        # CI 环境
```

CI 里执行：

```bash
docker compose -f compose.yml -f compose.ci.yml up -d
```

## 小结

Docker Compose 的核心价值不是"容器化部署"，而是**让开发环境变成代码**。把环境配置提交进仓库，任何人、任何机器都能一键复现，这才是它真正解决的问题。

对个人项目来说，一个简单的 compose.yml 就能省去大量"环境没配好"的时间，值得从第一天就养成这个习惯。
