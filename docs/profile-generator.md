# 프로젝트 프로필 생성기 가이드

이 문서는 **프로필 생성기(`generate-project-profile`) 사용법**과 **백엔드 스키마 기준 전체 옵션**을 설명합니다.  
생성기는 기본값만 채우며, 실제 환경에 맞게 사용자가 수정하는 것을 전제로 합니다.

## 1) 생성기 사용법

```bash
npm run generate-project-profile -- <repo_path> <login_url> <id> <pw> [otp]
```

예시:
```bash
npm run generate-project-profile -- /home/ubuntu/dokodemodoor/repos/juice-shop http://172.20.208.1:3002/#/login admin@juice-sh.op admin123 000000
```

출력:
- `configs/<repo_basename>-profile.yaml`
- 예: `configs/juice-shop-profile.yaml`

## 2) 생성기가 채우는 기본값

생성기는 **`authentication`과 `rules`만 생성**합니다.

### authentication (기본값)
- `login_type`: 항상 `form`
- `login_url`: 입력값 사용
- `credentials.username`, `credentials.password`: 입력값 사용
- `credentials.totp_code`: `[otp]`가 있으면 추가
- `login_flow`: **하드코딩 템플릿** (사용자가 직접 수정)
- `success_condition`: **하드코딩** (URL 포함 조건)

### rules (기본값)
- `focus`: OpenAPI/코드/README에서 경로를 추출해 **중요 키워드 기반**으로 제안
- `avoid`: logout/static 경로 위주로 제안

> 주의: 생성 결과는 “초기 초안”입니다. 실제 앱 흐름에 맞게 반드시 수정하세요.

---

## 3) 백엔드 스키마 기준 전체 옵션

아래는 실제 백엔드에서 허용하는 모든 필드(`configs/config-schema.json` 기준)입니다.

### authentication

필수:
- `login_type`: `form | sso | api | basic`
- `login_url`: 로그인 페이지/엔드포인트 URL
- `credentials`: 자격 증명
- `success_condition`: 로그인 성공 판단 조건

선택:
- `login_flow`: 로그인 절차 단계 목록 (최대 20개)

#### authentication.credentials

필수:
- `username`: 사용자명 또는 이메일
- `password`: 비밀번호

선택:
- `totp_code`: 고정 6자리 OTP 코드
- `totp_secret`: Base32 인코딩된 TOTP 시드

#### authentication.success_condition

필수:
- `type`: `url_contains | element_present | url_equals_exactly | text_contains`
- `value`: 조건 값

예시:
```yaml
success_condition:
  type: "element_present"
  value: "button#logout"
```

---

### rules

`rules`는 “집중/회피” 범위를 정의합니다.

#### rules.focus / rules.avoid

각 항목 형식:
```yaml
description: "설명"
type: "path"
url_path: "/api/Users/*"
```

허용되는 `type`:
- `path`
- `subdomain`
- `domain`
- `method`
- `header`
- `parameter`

중요:
- **하드 필터는 현재 `path/subdomain/domain`만 반영**합니다.
- `method/header/parameter`는 스키마상 허용되지만 하드 필터에는 반영되지 않습니다.

경로 패턴:
- 리터럴 경로 또는 glob 와일드카드
  - `/api/Users/*`
  - `/rest/products/search*`
  - `/assets/*`

예시:
```yaml
rules:
  focus:
    - description: "User and permission related APIs"
      type: "path"
      url_path: "/api/Users/*"
    - description: "Payment and card management"
      type: "path"
      url_path: "/api/Cards/*"
  avoid:
    - description: "Avoid static assets"
      type: "path"
      url_path: "/assets/*"
    - description: "Avoid logout endpoints"
      type: "path"
      url_path: "/logout*"
```

---

### mcpServers (고급)

커스텀 MCP 서버를 추가할 때 사용합니다.

#### stdio 타입
```yaml
mcpServers:
  myServer:
    type: "stdio"
    command: "node"
    args: ["./path/to/server.js"]
    env:
      API_KEY: "..."
```

#### sse 타입
```yaml
mcpServers:
  mySseServer:
    type: "sse"
    url: "http://localhost:7000/sse"
```

필수:
- `type`: `stdio | sse`

선택:
- `command`, `args`, `env` (stdio)
- `url` (sse)

---

### deprecated

- `login`: 과거 섹션이며 현재는 사용하지 않습니다. `authentication`을 사용하세요.

---

## 4) 생성 후 체크리스트

1. `login_flow`를 실제 UI 동작에 맞게 수정합니다.
2. `success_condition`이 로그인 성공을 정확히 판별하는지 확인합니다.
3. `rules.focus/avoid`가 실제 테스트 범위와 맞는지 검토합니다.
