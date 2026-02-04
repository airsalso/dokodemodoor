# 소스코드 분석 및 주석 작성 프롬프트

다음 코드를 분석하고 프로젝트 이해를 돕는 체계적인 주석을 추가해주세요.

## 주석 작성 규칙

각 함수/메서드/클래스에 대해 다음 형식으로 주석을 작성해주세요:

### 필수 항목
1. **목적(Purpose)**: 이 코드가 무엇을 하는지 한 문장으로 요약
2. **호출자(Called by)**: 이 기능을 누가 어디서 호출하는지
   - 파일명, 함수명, 라인 번호 (가능한 경우)
   - 호출 컨텍스트 (예: 사용자 이벤트, API 요청, 초기화 시점)
3. **출력 대상(Output to)**: 이 기능의 결과가 어디로 전달되는지
   - 반환값을 받는 호출자
   - 수정하는 전역 상태나 데이터베이스
   - 트리거하는 이벤트나 콜백

### 권장 항목
4. **입력 파라미터(Input Parameters)**: 각 파라미터의 의미와 예상 타입/값
5. **반환값(Return Value)**: 반환하는 값의 의미와 타입
6. **부작용(Side Effects)**: 함수 실행 시 발생하는 상태 변경
   - 전역 변수 수정
   - 파일/DB/네트워크 I/O
   - 다른 함수 호출로 인한 연쇄 효과
7. **의존성(Dependencies)**: 이 코드가 의존하는 외부 모듈, 서비스, 전역 상태
8. **실행 흐름(Flow)**: 주요 로직의 실행 순서 (복잡한 경우만)
9. **에러 처리(Error Handling)**: 어떤 에러를 어떻게 처리하는지
10. **주의사항(Notes)**: 알아야 할 특이사항, 제약조건, TODO 항목

## 주석 형식 예시
```python
def process_payment(user_id, amount, payment_method):
    """
    [목적] 사용자의 결제를 처리하고 주문 상태를 업데이트

    [호출자]
    - checkout_controller.py::finalize_order() (Line 45)
    - subscription_service.py::renew_subscription() (Line 123)
    - 컨텍스트: 사용자가 결제 버튼 클릭 후 호출

    [출력 대상]
    - 호출자에게 transaction_id 반환
    - orders 테이블의 status 컬럼 업데이트
    - payment_completed 이벤트 발행 → notification_service로 전달

    [입력 파라미터]
    - user_id (int): 결제하는 사용자 ID
    - amount (float): 결제 금액 (USD 기준)
    - payment_method (str): 'card' | 'paypal' | 'bank'

    [반환값]
    - dict: {'transaction_id': str, 'status': 'success'|'failed', 'timestamp': datetime}

    [부작용]
    - DB: orders 테이블 status='paid'로 업데이트
    - 외부 API: payment_gateway.charge() 호출
    - 이벤트: EventBus에 payment_completed 이벤트 발행

    [의존성]
    - payment_gateway 모듈 (Stripe API)
    - database.orders 테이블
    - EventBus 싱글톤 인스턴스

    [에러 처리]
    - PaymentFailedException: 결제 실패 시 롤백 후 재발생
    - DatabaseException: 로그 기록 후 500 에러 반환

    [주의사항]
    - 이 함수는 트랜잭션 내에서 실행되어야 함
    - amount는 반드시 양수여야 함 (검증 로직 있음)
    - TODO: 환불 기능 추가 필요
    """
    # 코드...
```

## 분석할 코드

[여기에 분석할 코드를 붙여넣으세요]

## 추가 요청사항

- 코드 전체의 아키텍처 흐름도 간단히 설명
- 주요 진입점(entry points) 파악
- 데이터 흐름(data flow) 추적
- 핵심 비즈니스 로직이 어디 있는지 표시
```

---

## 프롬프트 사용 팁

1. **단계적 분석**: 전체 프로젝트를 한 번에 주지 말고, 파일 단위나 모듈 단위로 나눠서 분석 요청

2. **컨텍스트 제공**: 프로젝트의 전반적인 목적과 기술 스택을 먼저 알려주면 더 정확한 분석 가능

3. **반복 개선**: 첫 분석 결과를 보고 추가로 궁금한 부분이나 불명확한 부분을 재질문

4. **다이어그램 요청**: 복잡한 흐름은 Mermaid 다이어그램으로 시각화 요청

예시:
```
"위 코드의 함수 호출 관계를 Mermaid 플로우차트로 그려줘"
