# AWS Emulator image. AWS publishes no prebuilt image; this installs the Linux package.
# https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html
#
# EMULATOR_ARCH is x86_64 or aarch64 (the Makefile derives it from the host).
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
ARG EMULATOR_ARCH=x86_64
ARG EMULATOR_CHANNEL=LTS/latest
ADD https://downloads.aws.com/aws-emulator/packages/aws-emulator/${EMULATOR_CHANNEL}/aws-emulator-${EMULATOR_ARCH}.rpm /tmp/aws-emulator.rpm
RUN rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \
    && mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator
EXPOSE 9297
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
