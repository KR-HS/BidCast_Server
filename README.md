# BIDCAST SERVER 입니다.

## 🎥 실시간 방송(WebRTC)을 활용한 온라인 경매 플랫폼
**BIDCAST**는 누구나 경매를 개설하고 입찰에 참여할 수 있는 실시간 영상 기반 경매 시스템입니다.  
실시간 채팅, 영상 공유, 입찰 기능을 통해 생동감 있는 경매 경험을 제공합니다.

🔗 [BIDCAST 서버 GitHub](https://github.com/KR-HS/BidCast_Server)
🔗 [BIDCAST 클라이언트 GitHub](https://github.com/KR-HS/BidCast) 
🌐 [BIDCAST 홈페이지](https://bidcast.kro.kr)

---
> ⚠️ **주의**: `dbconfig.js` 파일은 Git에 포함되지 않습니다.
> 내부의 DB코드들 또한 DB에 맞게 수정 또는 생성하여 사용해야합니다.
> *직접 root 경로에 아래 내용을 포함한 파일을 추가해주세요:*

<details>
<summary><code>dbconfig.js</code> 예시 보기</summary>

```
const dbConfig = {
    user: '유저이름',
    host: 'DB주소',
    database: 'DB이름',
    password: '패스워드',
    port: 5432,
    ssl: { rejectUnauthorized: false }
}
 
export default dbConfig;
```
</details> 

+ 
