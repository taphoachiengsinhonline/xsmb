// Thứ tự 27 giải
const PRIZE_ORDER = ['ĐB','G1','G2a','G2b','G3a','G3b','G3c','G3d','G3e','G3f','G4a','G4b','G4c','G4d','G5a','G5b','G5c','G5d','G5e','G5f','G6a','G6b','G6c','G7a','G7b','G7c','G7d'];

// Định nghĩa các nhóm lớn và nhóm nhỏ
const GROUPS = {
    G1: { // Nhóm lớn 1
        name: 'Nhóm 1',
        prizes: PRIZE_ORDER.slice(0, 9),
        subgroups: {
            G1A: { name: 'Nhóm 1A', prizes: PRIZE_ORDER.slice(0, 3) }, // ĐB, G1, G2a
            G1B: { name: 'Nhóm 1B', prizes: PRIZE_ORDER.slice(3, 6) }, // G2b, G3a, G3b
            G1C: { name: 'Nhóm 1C', prizes: PRIZE_ORDER.slice(6, 9) }, // G3c, G3d, G3e
        }
    },
    G2: { // Nhóm lớn 2
        name: 'Nhóm 2',
        prizes: PRIZE_ORDER.slice(9, 18),
        subgroups: {
            G2A: { name: 'Nhóm 2A', prizes: PRIZE_ORDER.slice(9, 12) },  // G3f, G4a, G4b
            G2B: { name: 'Nhóm 2B', prizes: PRIZE_ORDER.slice(12, 15) }, // G4c, G4d, G5a
            G2C: { name: 'Nhóm 2C', prizes: PRIZE_ORDER.slice(15, 18) }, // G5b, G5c, G5d
        }
    },
    G3: { // Nhóm lớn 3
        name: 'Nhóm 3',
        prizes: PRIZE_ORDER.slice(18, 27),
        subgroups: {
            G3A: { name: 'Nhóm 3A', prizes: PRIZE_ORDER.slice(18, 21) }, // G5e, G5f, G6a
            G3B: { name: 'Nhóm 3B', prizes: PRIZE_ORDER.slice(21, 24) }, // G6b, G6c, G7a
            G3C: { name: 'Nhóm 3C', prizes: PRIZE_ORDER.slice(24, 27) }, // G7b, G7c, G7d
        }
    }
};

module.exports = { PRIZE_ORDER, GROUPS };
