dbconfig파일을 만들어서 같은 경로에 DB에 접근할수 있는 정보를 담아야 동작합니다.

내부의 DB코드들 또한 DB에 맞게 수정 또는 생성하여 사용해야합니다.

dbconfig파일 내용 형식:
const dbConfig = {
    user: '유저이름',
    host: 'DB주소',
    database: 'DB이름',
    password: '패스워드',
    port: 5432,
    ssl: { rejectUnauthorized: false }
}

export default dbConfig;
