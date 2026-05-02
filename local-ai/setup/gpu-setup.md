# 🚀 Kubernetes NVIDIA GPU (RTX 4070) Setup Guide

이 가이드는 Proxmox 가상화 환경에서 NVIDIA RTX 4070 GPU를 Passthrough한 Ubuntu VM(K8s Node)을 대상으로, 쿠버네티스 클러스터에서 GPU 자원을 인식하고 Ollama와 같은 AI 워크로드에서 사용할 수 있도록 설정하는 과정을 정리한 문서입니다.

## 💻 시스템 환경
- **GPU**: NVIDIA GeForce RTX 4070 Laptop (Mobile) / VRAM 8GB
- **OS**: Ubuntu 24.04 LTS (Noble Numbat)
- **Container Runtime**: containerd
- **K8s Version**: v1.34+ (Standard)
- **Cuda Version**: 13.2 지원 가능

---

## 1단계: NVIDIA 드라이버 설치 (Host VM)
Proxmox에서 GPU Passthrough 설정이 완료된 후, VM 내부에서 드라이버를 설치합니다.

```bash
# 1. 패키지 업데이트 및 추천 드라이버 확인
sudo apt update
ubuntu-drivers devices

# 2. 추천 드라이버 설치 (595-open 버전 권장)
sudo apt install -y nvidia-driver-595-open nvidia-utils-595

# 3. 시스템 재부팅 (드라이버 로드 필수)
sudo reboot

# 4. 설치 확인
nvidia-smi

Sun May  3 04:09:52 2026
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 595.58.03              Driver Version: 595.58.03      CUDA Version: 13.2     |
+-----------------------------------------+------------------------+----------------------+
| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |
| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |
|                                         |                        |               MIG M. |
|=========================================+========================+======================|
|   0  NVIDIA GeForce RTX 4070 ...    Off |   00000000:00:10.0 Off |                  N/A |
| N/A   47C    P8              4W /  115W |    5364MiB /   8188MiB |      0%      Default |
|                                         |                        |                  N/A |
+-----------------------------------------+------------------------+----------------------+

+-----------------------------------------------------------------------------------------+
| Processes:                                                                              |
|  GPU   GI   CI              PID   Type   Process name                        GPU Memory |
|        ID   ID                                                               Usage      |
|=========================================================================================|
|    0   N/A  N/A           24375      C   /usr/bin/ollama                        5354MiB |
+-----------------------------------------------------------------------------------------+
```

---

## 2단계: NVIDIA Container Toolkit 설치
컨테이너 런타임(containerd)이 GPU를 컨테이너 내부로 전달할 수 있게 해주는 툴킷을 설치합니다.

```bash
# 1. 저장소 GPG 키 및 리스트 등록
curl -fsSL [https://nvidia.github.io/libnvidia-container/gpgkey](https://nvidia.github.io/libnvidia-container/gpgkey) | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L [https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list](https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list) | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

# 2. 툴킷 설치
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
```

---

## 3단계: Containerd 설정 (NVIDIA Default Runtime)
쿠버네티스 플러그인이 NVML 라이브러리에 접근할 수 있도록 NVIDIA를 기본 런타임으로 설정하는 것이 가장 중요한 핵심입니다.

```bash
# 1. NVIDIA 런타임을 기본값으로 설정 (--set-as-default 옵션 필수)
sudo nvidia-ctk runtime configure --runtime=containerd --set-as-default

# 2. 설정 반영을 위해 서비스 재시작
sudo systemctl restart containerd

# 3. 설정 확인 (default_runtime_name = "nvidia" 확인)
grep "default_runtime_name" /etc/containerd/conf.d/99-nvidia.toml
```

---

## 4단계: Kubernetes NVIDIA Device Plugin 배포
쿠버네티스 스케줄러가 노드의 GPU 자원을 인지할 수 있도록 데몬셋(DaemonSet)을 배포합니다.

```bash
# 1. Device Plugin 배포 (v0.19.1 기준)
kubectl create -f [https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.19.1/deployments/static/nvidia-device-plugin.yml](https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.19.1/deployments/static/nvidia-device-plugin.yml)

# 2. 노드 자원 할당 확인 (숫자 "1"이 출력되면 성공)
kubectl get nodes -o json | jq '.items[].status.allocatable["[nvidia.com/gpu](https://nvidia.com/gpu)"]'
```

---

## 5단계: 워크로드 적용 (Ollama 예시)
배포용 YAML 파일의 `resources` 섹션에 GPU를 명시하여 AI 모델이 GPU 가속을 받도록 설정합니다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ollama
  namespace: sandbox
spec:
  template:
    spec:
      containers:
      - name: ollama
        image: ghcr.io/sdin99/sandbox-ai:latest
        resources:
          limits:
            nvidia.com/gpu: 1
            memory: "12Gi"
            cpu: "4"
          requests:
            nvidia.com/gpu: 1
            memory: "8Gi"
```

---

## 최종 동작 검증

1. Pod 상태: `kubectl get pods -n sandbox` 에서 Ollama가 `Running`인지 확인.
2. 속도 체감: CPU 대비 응답 속도가 폭포수처럼 쏟아지는지 확인.
3. 리소스 점유: AI 답변 도중 호스트에서 `watch nvidia-smi`를 실행하여 `ollama` 프로세스의 VRAM 점유 확인.

---

## 문제 해결 (Troubleshooting)

- ERROR_LIBRARY_NOT_FOUND: 3단계에서  `--set-as-default`를 생략하면 플러그인이 GPU 라이브러리를 찾지 못해 CrashLoopBackOff가 발생합니다.
