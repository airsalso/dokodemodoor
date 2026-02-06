# Dokodemodoor SQL/NoSQL Injection Analysis Flow Audit

## 📋 점검 대상 경로 (SQLI 중심)
1. **[기초] Pre-Recon**: `pre-recon-code.txt` (RAW SQL 및 NoSQL 인젝션 지표 포착)
2. **[정찰] Recon**: `recon.txt` (DB 종류 식별 및 데이터베이스 상호작용 지점 매핑)
3. **[검증] Recon-Verify**: `recon-verify.txt` (ORM 미사용 또는 Raw Query 사용 지점 도달 가능성 검증)
4. **[동적] API Fuzzer**: `api-fuzzer.txt` (에러 메시지 기반 데이터베이스 구조 파악 및 Blind SQLi 시도)
5. **[분석] Vuln-SQLI**: `vuln-sqli.txt` (쿼리 매개변수 바인딩 누락 및 NoSQL 연산자 주입 정밀 분석)

---

## 🔍 단계별 상세 점검 결과

### 1단계: Pre-Recon (`pre-recon-code.txt`)
- **분석 지침**: `SQL/NoSQL injection candidates`를 최우선 분석 영역으로 설정 (119행).
- **역역**: 코드 베이스 전체에서 DB 쿼리가 생성되는 지점(Repository, DAO 등)을 빠르게 열거.

### 2단계: Recon (`recon.txt`)
- **인벤토리**: Section 9.1을 통해 SQL/NoSQL 노출 지점을 독자적으로 집계 (310행).
- **데이터 흐름**: 유저 인입 데이터가 어떻게 데이터베이스 쿼리문까지 도달하는지 'Source-to-Sink' 경로 확보.

### 3단계: Recon-Verify (`recon-verify.txt`)
- **실증 검증**: `CATEGORY: SQLI`를 통해 실제 코드 기반의 'File:Line' 증거 확보 및 경로 교정 (13행).
- **집중 타겟팅**: 단순 ORM 사용이 아닌, `literal`이나 `raw` 같은 위험한 API 사용 지점 선별.

### 4단계: API Fuzzer (`api-fuzzer.txt`)
- **DB 핑거프린팅**: 고의적인 구문 오류를 발생시켜 DB 서버의 종류와 버전을 유추할 수 있는 정보 수집.
- **안정성**: `BASH-PRECISION` 규칙을 통해 복잡한 SQL 페이로드 전송 시 패킷 왜곡 방지.

### 5단계: Vuln-SQLI (`vuln-sqli.txt`) -- **최근 대폭 강화됨**
- **DB 유형별 특화**: PostgreSQL, MySQL 등 RDBMS 종류를 선제적으로 파악하여 각 DB에 맞는 전용 함수 및 문법 분석 (Section 7).
- **ORM 정밀 감시**: Sequelize(`literal`), Knex(`raw`), Prisma(`$queryRaw`) 등 최신 프레임워크의 위험한 Raw API 리스트 명시 (Section 2.1).
- **주입 슬롯(Slot) 분류**: `SQL-val`, `SQL-ident`, `SQL-enum` 등으로 세분화하여 각 문맥에 맞는 방어 기법 대조.
- **Order By 인젝션 강조**: Bind 변수 사용이 불가능한 `Order By`나 `Group By` 절에서의 문자열 결합을 'High Risk'로 자동 분류.
- **NoSQL 심층 분석**: MongoDB 연산자 주입(`$ne`, `$regex`) 및 aggregation pipeline 구조 변형 가능성 체크.

---

## ✅ 점검 결론
SQL/NoSQL 인젝션 분석 체인은 **"ORM 기반 앱에 숨겨진 Raw Query 리스크"**를 찾아내는 데 최적화됨. 특히 현대적인 Node.js 환경에서 발생할 수 있는 특수한 인젝션 패턴(OrderBy, NoSQL Operator Injection)을 정확하게 탐지할 수 있는 '전문화된 눈'을 갖추게 됨.

---
*Prepared by Antigravity (Advanced Agentic Coding)*
