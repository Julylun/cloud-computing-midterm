export function createStudentProfile({ fullName, studentId }) {
  if (typeof fullName !== 'string' || !fullName.trim()) {
    throw new Error('Họ tên sinh viên không hợp lệ.');
  }
  if (typeof studentId !== 'string' || !/\d{3}$/.test(studentId)) {
    throw new Error('MSSV phải kết thúc bằng ít nhất ba chữ số.');
  }

  const productPrefix = studentId.slice(-3);
  const vatPercent = Number(studentId.at(-1)) + 5;
  return Object.freeze({
    fullName: fullName.trim(),
    studentId,
    productPrefix,
    vatPercent,
    databaseName: `DB_${studentId}`,
  });
}

export const student = createStudentProfile({
  fullName: 'Hoàng Xuân Luân',
  studentId: '23IT150',
});
