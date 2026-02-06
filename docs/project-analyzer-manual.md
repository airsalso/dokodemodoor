# Project Analyzer 메뉴얼

## 목적
이 프로그램은 소스 코드를 분석해 애플리케이션의 **컨텍스트 정보**를 추출합니다. 결과물은 XBOW와 같은 블랙박스 펜테스트 도구가 애플리케이션의 구조와 정상 동작을 이해하도록 보조하는 데 사용됩니다.

## 주요 특징
- 시스템 프롬프트 기반 분석(`analyzer/analyzer_prompts.txt`)
- 프로젝트 주요 파일 및 라우팅 단서 수집
- 결과를 지정 형식의 텍스트로 저장

## 실행 방법
```bash
npm run project-analyzer -- <프로젝트폴더경로>
```

예시:
```bash
npm run project-analyzer -- /home/ubuntu/dokodemodoor/repos/juice-shop
```

## 입력
- 프로젝트 폴더 경로
- 분석 시스템 프롬프트 파일: `analyzer/analyzer_prompts.txt`

## 출력
- 경로: `configs/<프로젝트폴더명>-analyze.txt`
- 예시: `configs/juice-shop-analyze.txt`

## 동작 개요
- `README.md`, `package.json` 등 기본 문서 수집
- `Dockerfile`, `docker-compose`, `.env.example`, `configs/*.yml` 등 구성 단서 수집
- 라우트/인증/API 관련 키워드 매칭으로 컨텍스트 생성
- LLM에 시스템 프롬프트 + 컨텍스트를 주입하여 **Application Context** 출력

## 주의사항
- LLM 엔드포인트는 `.env`의 `VLLM_BASE_URL`을 사용합니다.
- vLLM이 접근 가능해야 분석이 완료됩니다.
- 출력은 보안 취약점 분석이 아닌 **애플리케이션 구조 요약**입니다.

## 문제 해결
- `rg: command not found` 오류가 발생하면 ripgrep을 설치하세요.
  ```bash
  sudo apt-get update && sudo apt-get install -y ripgrep
  ```

- 결과 파일이 생성되지 않으면 LLM 연결 상태를 확인하세요.

