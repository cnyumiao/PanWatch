# PanWatch Dockerfile
# 多阶段构建，减小最终镜像大小

# ===== Stage 1: 前端构建 =====
# 静态资源与目标架构无关，使用构建机原生平台，避免 ARM 镜像构建时通过 QEMU 跑 pnpm。
FROM --platform=$BUILDPLATFORM node:24.14.0-alpine AS frontend-builder

WORKDIR /app/frontend

# 启用并固定 pnpm，避免镜像构建时随 npm 全局安装漂移
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# 复制依赖文件
COPY frontend/package.json frontend/pnpm-lock.yaml ./

# 安装依赖
RUN pnpm install --frozen-lockfile

# 复制源码并构建
COPY frontend/ ./
RUN pnpm build


# ===== Stage 2: Python 依赖构建 =====
# 构建与运行使用相同的 Python / Debian 版本，保证原生 wheel 的 ABI 一致。
FROM python:3.11-slim-bookworm AS python-builder

WORKDIR /app

# Git 只用于构建 TradingAgents，不带入最终镜像及其 Perl 依赖。
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# 这条网络对 HTTP/2 很不稳：clone TradingAgents 经常断在
# "RPC failed; curl 16 Error in the HTTP2 framing layer"。
# 对 GitHub 退回 HTTP/1.1，并放宽 pip 的超时/重试，避免整次构建因瞬时断流失败。
RUN git config --system http.version HTTP/1.1
ENV PIP_DEFAULT_TIMEOUT=60 \
    PIP_RETRIES=10

COPY requirements-runtime.txt ./

# 第三方依赖单独一层：本层只依赖 requirements-runtime.txt，改 `packages/` 下的本地源码
# 不会让这层失效，也就不会重新 clone TradingAgents、重新下载 langchain 等重依赖。
# pip 的 wheel 缓存挂到 BuildKit cache 上：确实需要重装时（改 requirements 或首次构建），
# 已下载的 wheel 直接复用；脚本自动重试时也不用从零开始。
RUN --mount=type=cache,target=/root/.cache/pip \
    grep -vE '^[[:space:]]*(-e|--editable)([[:space:]]|$)' requirements-runtime.txt \
        > /tmp/requirements-thirdparty.txt \
    && pip install --no-compile --prefix=/install -r /tmp/requirements-thirdparty.txt

# 本仓 packages 是纯 Python、体量小，放在最后安装：改源码只重装这几个本地包。
COPY packages/ ./packages/

# 本地开发保留 editable 安装；镜像内安装正常包，不依赖源码目录。
# 不预编译字节码，避免把 .pyc 缓存打进镜像。
# PYTHONPATH 让 resolver 看到上一层已装的依赖，避免重复安装和跨层版本冲突。
RUN --mount=type=cache,target=/root/.cache/pip \
    sed -nE 's/^[[:space:]]*(-e|--editable)[[:space:]]+//p' requirements-runtime.txt \
        > /tmp/requirements-local.txt \
    && PYTHONPATH=/install/lib/python3.11/site-packages \
       pip install --no-compile --prefix=/install -r /tmp/requirements-local.txt


# ===== Stage 3: Python 运行环境 =====
FROM python:3.11-slim-bookworm

WORKDIR /app

# 安装系统依赖
# - tzdata: 时区数据（zoneinfo 模块需要）
# - 中文字体（K线截图需要）
# - Playwright 1.57 的 Debian 12 Chromium 依赖（无头截图）
#   https://github.com/microsoft/playwright/blob/v1.57.0/packages/playwright-core/src/server/registry/nativeDeps.ts
# 固定 Bookworm：Trixie 的 libgbm1 会强制引入 Mesa / LLVM 图形驱动栈。
# 不额外安装 GTK / EGL，截图使用 Chromium 自带的软件渲染。
RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata \
    # 中文字体
    fonts-noto-cjk \
    # PDF 导出所需的字体排版库
    libpangoft2-1.0-0 \
    libpangocairo-1.0-0 \
    # Playwright Chromium 依赖
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libx11-6 \
    libxcb1 \
    libxext6 \
    libfontconfig1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -fv

# 仅复制安装产物，构建工具和本地包测试留在 builder 中。
COPY --from=python-builder /install/ /usr/local/

# 注意: Playwright 浏览器将在首次启动时自动安装到 data 目录
# 这样可以减小镜像体积，并支持跨版本持久化

# 复制后端代码
COPY src/ ./src/
COPY server.py ./

# 写入版本号；延后声明，避免换版本号时让系统依赖安装缓存失效。
ARG VERSION=dev
RUN echo "${VERSION}" > VERSION

# 从前端构建阶段复制静态文件
COPY --from=frontend-builder /app/frontend/dist ./static/

# 创建数据目录
RUN mkdir -p /app/data

# 环境变量
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV DATA_DIR=/app/data
ENV DOCKER=1

# 默认时区（可在 docker run 时用 -e TZ=... 覆盖）
ENV TZ=Asia/Shanghai

# 暴露端口（保持 8000 不变，避免影响存量用户升级）
EXPOSE 8000

# 健康检查（使用 Python）
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')" || exit 1

# 启动命令
CMD ["python", "server.py"]
