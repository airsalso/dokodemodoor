# Ghidra Scripts for RE MCP Server

이 디렉토리에는 Ghidra headless analyzer에서 실행되는 GhidraScript 파일들이 위치합니다.

## 필요한 스크립트

| 스크립트 | 목적 | 입력 | 출력 |
|----------|------|------|------|
| `ListFunctions.java` | 함수 목록 추출 | filter(regex), limit | JSON: [{name, address, size}] |
| `Decompile.java` | 함수 디컴파일 | function_name 또는 address | JSON: {name, address, decompiled_code} |
| `ListImports.java` | Import DLL/함수 목록 | (없음) | JSON: [{dll, functions: [{name, address}]}] |
| `ListStrings.java` | 문자열 목록 | min_length, filter | JSON: [{address, value, references}] |
| `GetXrefs.java` | 교차참조 | target, direction | JSON: {to: [], from: []} |
| `SearchFunctions.java` | 패턴 검색 | pattern, category | JSON: [{name, address, match_type}] |

## 모든 스크립트 공통 규칙

1. 첫 번째 인자는 항상 JSON 출력 파일 경로
2. 출력은 UTF-8 JSON 형식
3. 오류 시 `{"error": "message"}` 형식으로 출력

## 구현 참고

- Ghidra 11.x+ GhidraScript API 사용
- `analyzeHeadless`의 `-postScript` 옵션으로 실행됨
- `getScriptArgs()` 메서드로 인자 수신
- `java.io.FileWriter`로 JSON 파일 출력

## 커뮤니티 참조

- [LaurieWired/GhidraMCP](https://github.com/LaurieWired/GhidraMCP) — REST 기반 구현 참조
- [Ghidra API Docs](https://ghidra.re/ghidra_docs/api/) — 공식 API 문서
