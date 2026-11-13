# AWS Emulator images. AWS publishes no prebuilt image; this installs the Linux package.
# https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html
#
# Two targets:
#   emulator  the emulator alone (GitHub Actions; tools run on the host)
#   dev       the emulator plus Node.js and what the build and tests need, so
#             the host needs only `make` and a container runtime (macOS)
#
# EMULATOR_ARCH is x86_64 or aarch64 (the scripts derive it from the host).

FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal AS emulator
ARG EMULATOR_ARCH=x86_64
ARG EMULATOR_CHANNEL=LTS/latest
ADD https://downloads.aws.com/aws-emulator/packages/aws-emulator/${EMULATOR_CHANNEL}/aws-emulator-${EMULATOR_ARCH}.rpm /tmp/aws-emulator.rpm
RUN rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \
    && mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator
EXPOSE 9297
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]

# Node.js comes from the official image; its binaries run on Amazon Linux 2023.
FROM docker.io/library/node:24-bookworm-slim AS node

FROM emulator AS dev
USER 0
# Build tools, then the shared libraries headless Chromium needs for the
# end-to-end tests (Playwright has no installer for Amazon Linux).
RUN dnf install -y make tar gzip gawk findutils which procps-ng libstdc++ \
      nss nspr atk at-spi2-atk at-spi2-core cups-libs dbus-libs expat libdrm \
      libxkbcommon libX11 libxcb libXcomposite libXdamage libXext libXfixes \
      libXrandr mesa-libgbm alsa-lib pango cairo \
    && dnf clean all
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && mkdir -p /home/dev /work && chmod 1777 /home/dev
# The repository is mounted at /work. The emulator is the container's main
# process and listens on loopback only: the tools reach it from inside, through
# `make` targets run with exec, so its port is never published.
ENV HOME=/home/dev \
    INSIDE_DEV_CONTAINER=1 \
    EMULATOR_RUNTIME=native \
    PLAYWRIGHT_BROWSERS_PATH=/work/.cache/ms-playwright
WORKDIR /work
USER 1000
EXPOSE 8080
# The emulator's log goes to .emulator/emulator.log in the repository, where
# `make emulator-logs` and `make report` read it.
ENTRYPOINT ["/bin/sh", "-c", "mkdir -p /work/.emulator && exec aws-emulator \"$@\" >/work/.emulator/emulator.log 2>&1", "--"]
