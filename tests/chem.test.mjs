import { solvePH, equivalenceVolume, unknownFromSeed, indicatorColorName } from '../js/chem.js';
const r = (x) => x.toFixed(2);
const P = (sample, Cs, Vs, titrant, Ct, Vt) => solvePH({ sample, Cs, Vs, titrant, Ct, Vt });
let fails = 0;
const check = (name, got, exp, tol = 0.03) => { const ok = Math.abs(got - exp) <= tol; if (!ok) fails++; console.log(ok ? 'OK ' : 'BAD', name, r(got), 'expected', exp); };
// 강산-강염기: 0.1 M HCl 25 mL + 0.1 M NaOH
check('HCl start', P('HCl', .1, 25, 'NaOH', .1, 0), 1.00);
check('HCl 12.5 mL', P('HCl', .1, 25, 'NaOH', .1, 12.5), 1.48); // 0.0333 M
check('HCl eq', P('HCl', .1, 25, 'NaOH', .1, 25), 7.00);
check('HCl +5 excess', P('HCl', .1, 25, 'NaOH', .1, 30), 11.96); // OH 0.5/55=0.00909
// 약산: 0.1 M CH3COOH 25 mL
check('AcOH start', P('CH3COOH', .1, 25, 'NaOH', .1, 0), 2.88);
check('AcOH half eq = pKa', P('CH3COOH', .1, 25, 'NaOH', .1, 12.5), 4.74);
check('AcOH eq', P('CH3COOH', .1, 25, 'NaOH', .1, 25), 8.72);
// 암모니아 + HCl
check('NH3 start', P('NH3', .1, 25, 'HCl', .1, 0), 11.13);
check('NH3 eq', P('NH3', .1, 25, 'HCl', .1, 25), 5.28);
// 황산: 2가, 중화점 50 mL
check('H2SO4 eq', P('H2SO4', .1, 25, 'NaOH', .1, 50), 7.0, 0.6); // 약간 염기성 (SO4 2- 약염기)
console.log('Veq H2SO4', equivalenceVolume('H2SO4', .1, 25, .1), 'Veq oxalic', equivalenceVolume('H2C2O4', .1, 10, .1));
check('oxalic 2nd eq', P('H2C2O4', .1, 10, 'NaOH', .1, 20), 8.3, 0.4);
console.log(unknownFromSeed('A1|20301', ['HCl','HNO3','CH3COOH','HCOOH']), unknownFromSeed('A1|20301', ['HCl','HNO3','CH3COOH','HCOOH']), unknownFromSeed('A1|20302', ['HCl','HNO3','CH3COOH','HCOOH']));
console.log(indicatorColorName('PP', 7), indicatorColorName('PP', 9.1), indicatorColorName('PP', 11), indicatorColorName('BTB', 6.8));
process.exit(fails ? 1 : 0);
