# 코드 리뷰: findings 압축 손실 방어 로직

**검토 대상**: `src/ai/providers/vllm-provider.js`  
**관련 로직**: `extractFindings`, `compressHistory`, `shrinkMessagesToFitLimit` (롱텀 메모리 보존)  
**검토 일자**: 2025-02  
**관점**: 제3자 객관적 감시(코드 리뷰·검토)

---

## 1. 검토 범위 요약

| 구분 | 내용 |
|------|------|
| 목적 | `deliverables/findings/<mission>/` 하위 todo.txt, staged_source_*, finding_*.md, findings_*.md 등 롱텀 메모리가 컨텍스트 압축/트리밍 시 손실되지 않도록 방어 |
| 변경 요약 | (1) `compressHistory`: 압축 마커에 staged 파일 목록 추가 (2) `shrinkMessagesToFitLimit`: 압축 마커가 잘리지 않도록 유지·재삽입 |

---

## 2. 정확성 및 동작 검증

### 2.1 데이터 소스 일관성

- **extractFindings**  
  - 디스크: `getMissionDir(targetDir, missionName, agentName)` 하위에서 `readdirSync` 후 `staged_*`, `finding_*`, `findings_*` + `.md` 필터.  
  - `todo.txt`는 별도 읽기, `doneTasks`는 todo 라인 파싱 + 툴 결과 파싱.  
  - **결론**: findings 폴더 하위의 todo·staged·finding(s)_*.md와 일치. 정상.

- **compressHistory**  
  - `extractFindings(messages, agentName, targetDir)` 호출로 디스크 + 메시지 기반 최신 상태 사용.  
  - 마커에 `findings.stagedFiles.join(', ')`, `findings.doneTasks`, `findings.lastTodo` 반영.  
  - **결론**: 압축 시점의 디스크/메모리 상태가 마커에 반영됨. 정상.

### 2.2 호출 순서 및 마커 위치

- **순서**: `query()` 루프 내  
  - 히스토리 크기 초과 시 `messages = this.compressHistory(messages, agentName, targetDir)`  
  - 이후 `buildReadyMessages()` → `prepareMessages(baseMessages)` → `shrinkMessagesToFitLimit(readyMessages, ...)`  
- **마커 위치**: `compressHistory`가 `messages = [initial, marker, ...recent]`로 in-place 수정하므로, 이후 `messages[1]`은 항상 `[HISTORY COMPRESSED]` 마커.  
- **shrinkMessagesToFitLimit**에서 `compressionMarker = messages[1]`로 참조하는 것은 이 순서와 일치.  
- **결론**: 호출 순서와 인덱스 가정 일치. 정상.

### 2.3 마커 재삽입 조건

- `compressionMarker.content.includes('[HISTORY COMPRESSED]')`로만 판별.  
- 압축을 한 번도 하지 않은 세션에서는 `messages[1]`이 일반 user/assistant 메시지이므로 해당 문자열이 없을 가능성이 높음 → 재삽입 안 함.  
- **결론**: 오탐(일반 메시지를 마커로 간주) 가능성 낮음. 정상.

### 2.4 enforceToolCallPairing과의 관계

- 마커는 `role: 'user'`, `content`만 가진 메시지.  
- `enforceToolCallPairing`은 assistant의 tool_calls와 tool 결과 짝만 관리하고, 그 외 메시지( user 포함)는 그대로 `filtered.push(m)`.  
- 마커 재삽입은 `enforceToolCallPairing` 호출 이후에 수행되므로, 재삽입된 배열은 pairing을 다시 거치지 않음.  
- 재삽입 결과는 `[initial, marker, ...rest]` 형태로, user(마커)가 연속될 수 있음. 일부 API는 user 연속을 합치거나 허용.  
- **결론**: 툴 짝 깨짐 없음. API 호환성은 백엔드에 따라 확인 권장.

---

## 3. 엣지 케이스 및 개선점

### 3.1 마커 길이 및 truncate 시 우선순위

- **현상**: `shrinkMessagesToFitLimit`에서 마커를 재삽입한 뒤 `totalSize(trimmed) > maxChars`이면 `truncateMessageContent(compressionMarker, markerLimit)` 호출.  
- `markerLimit = Math.max(500, Math.floor(maxChars * 0.2))`로 앞부분만 유지.  
- 마커 형식이 `[HISTORY COMPRESSED]` → **STATUS** → Completed → Staged → **Long-term memory (findings): ...** → Todo 순이므로, 500자 근처에서 잘리면 **파일 목록이 잘릴 수 있음**.  
- **권장**: 마커 truncate 시 “Long-term memory (findings):” 라인을 우선 유지하도록, 해당 블록을 찾아 앞쪽(Completed/Todo)을 먼저 줄이는 로직을 두면 더 안전함. (선택 개선)

### 3.2 stagedFiles 수가 많을 때

- **현상**: `findings.stagedFiles.join(', ')`에 상한이 없어, 파일이 매우 많으면 마커가 비대해짐.  
- **적용**: 설정 한 칸으로 정책 분리. **contextCompressionMaxStagedFiles** (env: `DOKODEMODOOR_CONTEXT_COMPRESSION_MAX_STAGED_FILES`, 기본 20)를 사용. “요약에 표시할 staged 파일 이름 개수”만 담당하며, scope-caps(파일 오픈/검색 행위 상한)와 분리. `compressHistory`는 opts 없이 동작.

### 3.3 targetDir 미전달 시

- **현상**: `extractFindings`에서 `targetDir && targetDir !== '.'`이 아니면 디스크를 읽지 않아 `stagedFiles`가 빈 배열.  
- **결과**: `stagedList`는 `''`, 마커에는 `Staged: 0 files`만 남음.  
- **결론**: 정상 동작. 디스크 상태를 모를 때는 보수적으로 0 files로 표시하는 것이 맞음.

### 3.4 “Absolute last resort” 후 재삽입

- **현상**: `trimmed = [truncateMessageContent(initial, ...)]` (길이 1)까지 간 뒤, 마커 재삽입으로 `trimmed = [initial, compressionMarker]` (길이 2).  
- 이때 `totalSize(trimmed) > maxChars`이면 마커를 `markerLimit`으로 자름.  
- **결론**: 최후 단계에서도 마커는 “요약”으로라도 남도록 되어 있음. 적절함.

---

## 4. 보안·안정성

- **입력**: `extractFindings`의 디스크 경로는 `getMissionDir` 등 기존 제어 하에 있음.  
- **출력**: 마커는 내부 컨텍스트용 문자열이며, 사용자 입력을 이스케이프 없이 넣는 부분은 `findings.lastTodo`, `doneTasks`, `stagedFiles`(파일명). 파일명/할일 텍스트는 에이전트·파일시스템 제어 하에 있다고 가정.  
- **결론**: 특별한 주입 경로는 보이지 않음. 운영 환경에서 todo/파일명에 대한 정책은 기존과 동일하게 유지하면 됨.

---

## 5. 종합 판정 및 권장 사항

| 항목 | 판정 | 비고 |
|------|------|------|
| extractFindings와 디스크/마커 일치 | ✅ 적절 | mission 디렉터리·필터 일치 |
| compressHistory 마커 내용 | ✅ 적절 | staged 목록·todo·done 반영 |
| shrinkMessagesToFitLimit 마커 유지 | ✅ 적절 | 인덱스 1 가정·재삽입·과도 시 truncate |
| 호출 순서·인덱스 가정 | ✅ 일치 | compress 후 shrink 사용 순서와 맞음 |
| 엣지 케이스 | ⚠️ 일부 개선 여지 | 마커 truncate 시 파일 목록 우선 유지, staged 상한 |

**종합**: findings 폴더 하위 todo.txt, staged_source_*, finding_*.md, findings_*.md에 대한 압축 손실 방어 로직은 **목적에 맞게 구현되어 있으며**, 제3자 검토 기준으로 **적절히 동작할 것으로 판단**됩니다.  
위 “권장” 사항은 엣지 케이스와 유지보수성을 위한 선택 개선이며, 현재 코드만으로도 핵심 시나리오에서는 롱텀 메모리 보존이 이루어지는 구조입니다.
