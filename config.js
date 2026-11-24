// 선생님이 바꾸는 설정 파일
window.LAB_CONFIG = {
  // AI 조교 중계 서버(Cloudflare Worker) 주소. 비워 두면 AI 조교 대신 '상태 복사' 버튼이 나와요.
  // 예: "https://titration-ai.내계정.workers.dev"
  aiEndpoint: "",

  // 탐구·평가 모드에서 무작위로 배정할 미지 산 (1가 산만 넣는 것을 추천)
  // 사용 가능: "HCl", "HNO3", "CH3COOH", "HCOOH", "H2SO4", "H2C2O4"
  unknownPool: ["HCl", "HNO3", "CH3COOH", "HCOOH"],

  // 미지 산 농도 범위 (M, 0.005 간격)
  unknownRange: [0.05, 0.20],

  // 평가 모드에서 학생이 고를 수 없게 고정할 설정 (null이면 학생이 선택)
  evalFixed: {
    noise: "real",     // 평가는 측정 오차가 있는 '현실적' 모드로 고정
  },

  // 연습 모드에서 뷰렛 눈금 숫자를 보여 줄지
  showReadingInPractice: true,
};
