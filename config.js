// 선생님이 바꾸는 설정 파일
window.LAB_CONFIG = {
  // AI 조교 중계 서버(Cloudflare Worker) 주소. 비워 두면 AI 조교 대신 '상태 복사' 버튼이 나와요.
  // 예: "https://titration-ai.내계정.workers.dev"
  aiEndpoint: "",

  // 결과 정리 전에 마쳐야 하는 실험 회차 수
  requiredTrials: 3,

  // 이론 학습 화면의 영상 (유튜브 영상 ID와 시작 시각(초))
  // 영상 ID는 유튜브 주소 watch?v= 뒤의 11자리예요. 수업 전에 꼭 직접 재생해 보고 바꾸세요.
  videos: [
    { id: "2mLV_RNvBQg", start: 1014, title: "지시약의 변색 범위", source: "화학 반응의 세계 3강: 중화 적정 곡선 (16:54부터)" },
    { id: "2mLV_RNvBQg", start: 1397, title: "강산–강염기 적정 곡선", source: "화학 반응의 세계 3강: 중화 적정 곡선 (23:17부터)" },
    { id: "2mLV_RNvBQg", start: 2303, title: "약산–강염기 적정과 반당량점", source: "화학 반응의 세계 3강: 중화 적정 곡선 (38:23부터)" },
    { id: "opznlRvs_G0", start: 0, title: "실제 실험: HCl–NaOH 중화 적정", source: "[실험] HCl-NaOH 중화적정 탐구실험" },
    { id: "WDqrX1t0Cvk", start: 0, title: "뷰렛 사용법", source: "[화학 실험] 중화 적정 / 뷰렛 사용법" },
  ],

  // 탐구·평가 모드에서 무작위로 배정할 미지 산 (1가 산만 넣는 것을 추천)
  // 사용 가능: "HCl", "HNO3", "CH3COOH", "HCOOH", "H2SO4", "H2C2O4"
  unknownPool: ["HCl", "HNO3", "CH3COOH", "HCOOH"],

  // 미지 산 농도 범위 (M, 0.005 간격)
  unknownRange: [0.05, 0.20],

  // 평가 모드에서 학생이 고를 수 없게 고정할 설정
  evalFixed: {
    noise: "real",     // 평가는 측정 오차가 있는 '현실적' 모드로 고정
  },

  // 연습 모드에서 뷰렛 눈금 숫자를 보여 줄지
  showReadingInPractice: true,
};
