import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import mediasoup from 'mediasoup'


// npm install pg
// PostgreSql연동
import pkg from 'pg';
const { Pool } = pkg;
import dbConfig from './dbconfig.js';

const pool = new Pool(dbConfig);
export default pool;

const app = express()
const httpServer = http.createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } }) // CORS 허용


const mediasoupWorker = await mediasoup.createWorker()
console.log(`Mediasoup Worker pid: ${mediasoupWorker.pid}`)

const router = await mediasoupWorker.createRouter({
  mediaCodecs: [
    { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: {} },
    {
      kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: {
        'packetization-mode': 1,
        'profile-level-id': '42e01f',
        'level-asymmetry-allowed': 1,
      }
    }
  ],
})

const transports = new Map()
const producers = new Map() // key = roomid , value = Map(key = producerId, value= producer(프로듀서객체), socketId)
const consumers = new Map()
const socketRoomMap = new Map() // socketId -> roomId

const hostSocketId = null // 현재 호스트의 socket.id를 저장하는 변수

const socketIdMap = new Map(); // key:loginId, value:socket.id
const auctionHostMap = new Map(); // auctionId -> hostSocketId

const auctionStates = {}; // { auctionId: { selectedProduct: {...} } }
const auctionUserStatus = {}; // socketId:{nickname,lastBid}

function normalizeProduct(raw) {
  return {
    prodKey: raw.prod_key,
    aucKey: raw.auc_key,
    prodName: raw.prod_name,
    prodDetail: raw.prod_detail,
    unitValue: raw.unit_value,
    initPrice: raw.init_price,
    currentPrice: raw.current_price,
    finalPrice: raw.final_price,
    winnerId: raw.winner_id,
    prodStatus: raw.prod_status,

    fileUrl: raw.file_url
  };
}

async function emitGuestCount(auctionId) {
  console.log(auctionId)
  const room = io.of('/').adapter.rooms.get(auctionId);
  const count = room ? room.size : 0;
  io.emit('guestCountUpdate', { auctionId, guestCount: count });
}

io.on('connection', socket => {
  console.log('New socket connected:', socket.id)



  // 각 경매당 시청자수
  socket.on('get-guest-counts', ({ auctionIds }, callback) => {
    const guestCounts = {};

    for (const auctionId of auctionIds) {
      const room = io.sockets.adapter.rooms.get(auctionId);
      guestCounts[auctionId] = room ? room.size : 0; // 없으면 0으로 처리
    }

    callback(guestCounts);
  });




  // -------------
  // 상품 선택
  socket.on("host-selected-product", async ({ auctionId, product }) => {
    console.log("선택")

    //  서버 상태에 저장
    if (!auctionStates[auctionId]) auctionStates[auctionId] = {};
    auctionStates[auctionId].selectedProduct = product;

    console.log("상품선택", auctionStates);


    try {
      // DB에서 prod_status 업데이트 ('P'로 변경)
      await pool.query(
        'UPDATE product SET prod_status = $1 WHERE prod_key = $2',
        ['P', product.prodKey]
      );
    } catch (err) {
      console.error("🔥 prod_status 업데이트 중 오류:", err);
    }


    io.to(auctionId).emit("host-selected-product", { product });
  });

  // -------------
  // 낙찰/유찰
  socket.on("bid-status", async ({ auctionId, prodKey, winner_id, status }) => {
    console.log("물품상태", status)

    let winner = null;
    let nickname = null;

    const statusCode = status === "낙찰" ? 'C' : 'F';


    try {
      // bid_status 컬럼 업데이트
      await pool.query(
        'UPDATE product SET prod_status = $1 WHERE prod_key = $2',
        [statusCode, prodKey]
      );

      // 낙찰자 login_id 조회
      if (winner_id) {
        const result = await pool.query(
          'SELECT login_id, nickname FROM users WHERE user_key = $1',
          [winner_id]
        );

        if (result.rows.length > 0) {
          winner = result.rows[0].login_id;
          nickname = result.rows[0].nickname;
        }
      }

      // ❗ 해당 상품에 대한 입찰정보 초기화
      if (auctionUserStatus[auctionId]) {
        Object.entries(auctionUserStatus[auctionId]).forEach(([socketId, status]) => {
          if (status?.bids?.[prodKey]) {
            delete auctionUserStatus[auctionId][socketId].bids[prodKey];
          }
        });

        // 상태 전체 재전송
        io.to(auctionId).emit('user-status-update', auctionUserStatus[auctionId]);
      }


      // 다른 유저들에게 방송
      socket.to(auctionId).emit("bid-status", {
        prodKey,
        winner,
        nickname,
        status
      });

      auctionStates[auctionId].selectedProduct = null;

    } catch (err) {
      console.error("🔥 bid-status 처리 중 오류:", err);
    }
  });




  //////////////////////////////
  // 클라이언트가 입찰
  socket.on("bid-attempt", async ({ auctionId, productId, bidAmount, userLoginId }) => {
    console.log("받은값:", auctionId, productId, bidAmount, userLoginId);
    try {
      // 1) userLoginId → userKey, userName 조회
      const userRes = await pool.query(
        "SELECT user_key,nickname FROM users WHERE login_id = $1",
        [userLoginId]
      );
      if (userRes.rowCount === 0) {
        socket.emit("bid-rejected", { reason: "유효하지 않은 사용자입니다." });
        return;
      }
      const userKey = userRes.rows[0].user_key;
      const nickname = userRes.rows[0].nickname;

      console.log("1. 사용자 조회 완료");

      // 2) 현재 가격, 낙찰자 조회
      const prodRes = await pool.query(
        "SELECT current_price,init_price,unit_value FROM product WHERE prod_key = $1",
        [productId]
      );

      if (prodRes.rowCount === 0) {
        socket.emit("bid-rejected", { reason: "유효하지 않은 상품입니다." });
        return;
      }

      const { current_price, init_price, unitvalue } = prodRes.rows[0];
      const unit = unitvalue ?? 1000;

      const minimumBid = current_price === null ? init_price : current_price + unit;

      console.log("2. 현재가격,낙찰자 조회")
      console.log("입찰가격:", bidAmount, "최소입찰가:", minimumBid);


      // 3) 기존 가격보다 낮거나 같으면 거절
      if (bidAmount < minimumBid) {
        socket.emit("bid-rejected", { reason: `입찰 가격은 최소 ${minimumBid} 이상이어야 합니다.` });
        return;
      }

      console.log("3.경매요청가격 조건비교")

      // 4) 가격 갱신 및 낙찰자 변경
      const updateRes = await pool.query(
        `
          WITH updated AS (
            UPDATE product
            SET current_price = $1, final_price = $1, winner_id = $2
            WHERE prod_key = $3
            RETURNING *
          )
          SELECT u.*, f.file_url
          FROM updated u
          LEFT JOIN file f ON f.prod_key = u.prod_key;
        `,
        [bidAmount, userKey, productId]
      );

      const updatedProduct = normalizeProduct(updateRes.rows[0]);

      // 4-1) 경매입찰 기록 업데이트
      await pool.query(
        "INSERT INTO prodlist(user_key,prod_key,bidprice,auction_id) values($1,$2,$3,$4)",
        [userKey, productId, bidAmount, auctionId]
      );

      // selectedProduct 갱신
      if (auctionStates[auctionId]?.selectedProduct?.prodKey === productId) {
        auctionStates[auctionId].selectedProduct = updatedProduct;
      }


      console.log("4. 서버 선택된 상품상태변경 및 DB가격 갱신")
      console.log("DB 선택값 변경:", updatedProduct)
      console.log("서버 선택값 변경", auctionStates[auctionId].selectedProduct)
      // 5) 입찰 성공 정보 전송 (입찰자 소켓ID 포함)
      const payload = {
        product: updatedProduct,
        bidder: {
          userKey,
          userName: userLoginId,
          nickName: nickname,
          socketId: socket.id
        }
      };

      console.log("입찰 성공 정보 전송");
      // 6) 호스트 + 전체 참가자에게 입찰 결과 방송

      // 6) auctionUserStatus 갱신
      // 7) auctionUserStatus 갱신 - 상품별로 입찰 금액 기록
      if (!auctionUserStatus[auctionId]) auctionUserStatus[auctionId] = {};

      const userStatus = auctionUserStatus[auctionId][socket.id] || { userKey,nickname, bids: {} };
      userStatus.bids[productId] = bidAmount;
      auctionUserStatus[auctionId][socket.id] = userStatus;

      // 8) 모든 유저에게 입찰 정보 및 유저 상태 업데이트 전송
      io.to(auctionId).emit("user-status-update", auctionUserStatus[auctionId]);

      console.log("모든유저에전송")
      io.to(auctionId).emit("bid-update", payload);


    } catch (error) {
      console.error("입찰 처리 중 오류:", error);
      socket.emit("bid-rejected", { reason: "서버 오류로 입찰 실패" });
    }
  });


  ///////////////////////////
  // 호스트가 최고입찰자 변경 //
  //////////////////////////
  socket.on("revert-bidder", async ({ auctionId, prodKey, winnerId, finalPrice }) => {
    console.log("revert-bidder 요청 받음", { auctionId, prodKey, winnerId, finalPrice });

    try {
      // 1) product 테이블 낙찰자, 가격 업데이트
      const updateRes = await pool.query(
        `
          WITH updated AS (
            UPDATE product 
            SET final_price = $1, winner_id = $2 
            WHERE prod_key = $3
            RETURNING *
          )
          SELECT u.*, f.file_url
          FROM updated u
          LEFT JOIN file f ON f.prod_key = u.prod_key;
        `,
        [finalPrice, winnerId, prodKey]
      );

      if (updateRes.rowCount === 0) {
        socket.emit("error", { message: "상품을 찾을 수 없습니다." });
        return;
      }

      const updatedProduct = normalizeProduct(updateRes.rows[0]);

      // 2) auctionStates 상태도 업데이트 (선택 상품이 변경된 경우)
      if (auctionStates[auctionId]?.selectedProduct?.prodKey === prodKey) {
        auctionStates[auctionId].selectedProduct = updatedProduct;
      }

      // 3) 낙찰자 정보 조회 (닉네임 등)
      let winnerNickname = null;
      if (winnerId) {
        const userRes = await pool.query(
          'SELECT nickname FROM users WHERE user_key = $1',
          [winnerId]
        );
        if (userRes.rowCount > 0) {
          winnerNickname = userRes.rows[0].nickname;
        }
      }

      // 4) 모든 클라이언트에게 변경사항 방송
      io.to(auctionId).emit("bid-update", {
        product: updatedProduct,
        bidder: {
          userKey: winnerId,
          nickname: winnerNickname,
          // 추가 정보 필요시 여기에
        }
      });

      console.log("이전 입찰자 반영 완료:", updatedProduct);

    } catch (err) {
      console.error("revert-bidder 처리 중 오류:", err);
      socket.emit("error", { message: "이전 입찰자 반영 실패" });
    }
  });

  // -------------------
  // 채팅 메시지 저장 및 브로드캐스트
  // 클라이언트에서 보내는 데이터: { auctionId, userId, contents }
  socket.on('chat-message', async ({ auctionId, userId, contents }) => {
    try {
      const regdate = new Date()
      // user_id로 user_key 조회
      const userResult = await pool.query(
        'SELECT user_key,nickname FROM users WHERE login_id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        return callback({ error: 'Invalid user ID' });
      }

      const userKey = userResult.rows[0].user_key;
      const nickname = userResult.rows[0].nickname;
      console.log("채팅메시지들어옴 / 유저아이디, 닉네임가져옴", userKey, nickname)

      // chat에 저장
      await pool.query(
        `INSERT INTO chat (auc_key, user_key, content, reg_date)
   VALUES ($1, $2, $3, $4)`,
        [auctionId, userKey, contents, regdate]
      );

      // 방에 메시지 브로드캐스트 (자신 포함)
      io.to(auctionId).emit('chat-message', {
        nickname,
        contents,
        regdate: regdate.toISOString(),
      })
    } catch (err) {
      console.error('Error inserting chat message:', err)
    }
  })



  ///////////////////////////////////////////////////////////
  //            [ socketId와 로그인ID연결]            //
  //////////////////////////////////////////////////////////
  socket.on('register-login-id', async ({ loginId, auctionId }) => {
    const oldSocketId = socketIdMap.get(loginId);
    if (oldSocketId && oldSocketId !== socket.id) {
      io.to(oldSocketId).emit('force-disconnect');
      io.sockets.sockets.get(oldSocketId)?.disconnect();
      console.log(`Old socket ${oldSocketId} disconnected due to new login by ${loginId}`);
    }

    socketIdMap.set(loginId, socket.id);
    console.log(`[${loginId}] connected with socket ${socket.id}`);

    try {
      // 호스트 검증 (옵션)
      const { rows } = await pool.query(
        'SELECT auction_id FROM auction WHERE host_id = $1 AND auction_id = $2',
        [loginId, auctionId]
      );

      if (rows.length === 0) {
        console.warn(`User ${loginId} is not the host of auction ${auctionId}`);
        return;
      }

      auctionHostMap.set(auctionId, socket.id);

      // 해당 auctionId 방에 있는 모든 유저에게 hostSocketId 전파
      io.to(auctionId).emit('host-available', {
        auctionId,
        hostSocketId: socket.id
      });

      console.log(`Host [${loginId}] is now available for auction ${auctionId}`);
    } catch (err) {
      console.error('Error while registering host:', err);
    }

  });



  ////////////////////////
  //  경매 종료 요청 처리  //
  ////////////////////////
  socket.on('auction-end', async ({ auctionId }) => {
    try {
      // 1) DB에 경매 상태 '종료'로 업데이트
      await pool.query(
        "UPDATE auction SET status = '종료',end_time = NOW() WHERE auction_id = $1",
        [auctionId]
      );

      // 2) 해당 경매방(room) 내 모든 클라이언트에게 종료 알림 방송
      io.to(auctionId).emit('auction-ended', {
        auctionId,
        message: '경매가 종료되었습니다.'
      });

      console.log(`경매 ${auctionId} 종료 및 알림 완료`);

    } catch (error) {
      console.error('경매 종료 처리 중 오류:', error);
      socket.emit('error', { message: '경매 종료 처리 실패' });
    }
  });



  /////////////////////////////////////////////////////////
  //                   [특정 경매페이지 입장]               //
  /////////////////////////////////////////////////////////
  socket.on('join-auction', async ({ auctionId, loginId }, callback) => {
    try {

      // [방에 접속]
      const currentRoom = socketRoomMap.get(socket.id);

      // 이미 다른 방에 있다면, 나가게 한다
      if (currentRoom && currentRoom !== auctionId) {
        // 1. 기존 방에서 소켓이 만든 프로듀서들 닫고 제거
        const roomProducers = producers.get(currentRoom);
        if (roomProducers) {
          for (const [producerId, data] of roomProducers) {
            if (data.socketId === socket.id) {
              data.producer.close();
              roomProducers.delete(producerId);
              console.log(`Producer ${producerId} closed on room switch.`);
            }
          }
          if (roomProducers.size === 0) {
            producers.delete(currentRoom);
          }
        }

        // 2. 기존 방에서 소켓이 만든 컨슈머들 닫고 제거
        for (const [consumerId, data] of consumers) {
          if (data.socketId === socket.id) {
            data.consumer.close();
            consumers.delete(consumerId);
            console.log(`Consumer ${consumerId} closed on room switch.`);
          }
        }

        // 3. 소켓을 기존 방에서 나가게 함
        socket.leave(currentRoom);
        console.log(`Socket ${socket.id} left room ${currentRoom}`);
      }

      socket.join(auctionId);

      socketRoomMap.set(socket.id, auctionId)

      console.log(`User ${socket.id} joined auction ${auctionId}`)


      // 방에 접속한 소켓 수 계산
      const room = io.sockets.adapter.rooms.get(auctionId);
      const userCount = room ? room.size : 0;

      console.log(`현재 유저수 : ${userCount}`);
      // 방 내 모든 소켓에게 인원 수 업데이트 알림
      io.to(auctionId).emit('user-count-update', { auctionId, userCount });


      // [호스트 찾기]
      const result = await pool.query(
        'SELECT host_id FROM auction WHERE auction_id = $1',
        [auctionId]
      );

      console.log(result);
      if (result.rows.length === 0) {
        return callback({ error: 'Auction room not found' });
      }

      const hostLoginId = result.rows[0].host_id;

      if (loginId === hostLoginId) {
        await pool.query(
          'UPDATE auction SET status = $1 WHERE auction_id = $2 AND status=$3',
          ['진행중', auctionId, '진행예정']
        );
      }

      // loginId를 통해 해당 소켓 찾기
      let targetSocketId = socketIdMap.get(hostLoginId);


      if (!targetSocketId) {
        console.warn('Host not connected for auction:', auctionId);
        targetSocketId = null; // 혹은 빈 문자열 등 명확한 값
      }

      auctionHostMap.set(auctionId, targetSocketId)

      console.log(`Host for auction ${auctionId} is socket ${targetSocketId}`)


      // *** 채팅 내역 조회 추가 ***
      const chatResult = await pool.query(
        `SELECT u.nickname nickname, c.content contents, c.reg_date regdate
       FROM chat c
       left join users u
       on c.user_key = u.user_key
       WHERE c.auc_key = $1
       ORDER BY c.reg_date DESC
       LIMIT 40`,
        [auctionId]
      );

      const chats = chatResult.rows.reverse(); // 오름차순 정렬

      console.log("채팅내역", chats);
      const selectProduct = auctionStates[auctionId]?.selectedProduct;


      // auctionUserStatus 초기화
      if (!auctionUserStatus[auctionId]) auctionUserStatus[auctionId] = {};

      // 해당 유저 상품별 최고 입찰가 조회
      const userStatus = await pool.query(
        `SELECT prod_key, MAX(bidprice) AS bidprice
       FROM prodlist
       WHERE user_key = (SELECT user_key FROM users WHERE login_id = $1)
       GROUP BY prod_key`,
        [loginId]
      );


      // 닉네임 조회
      const findNick = await pool.query(
        `SELECT user_key,nickname FROM users WHERE login_id = $1`,
        [loginId]
      );

      console.log("닉네임조회", loginId, findNick);
      const nickname = findNick.rows.length > 0 ? findNick.rows[0].nickname : '알 수 없음';
      const userKey = findNick.rows.length>0?findNick.rows[0].user_key : null;

      // auctionUserStatus[auctionId][socket.id] 초기화
      if (!auctionUserStatus[auctionId][socket.id]) {
        auctionUserStatus[auctionId][socket.id] = {
          userKey,
          nickname,
          bids: {}, // 상품별 입찰가 객체 초기화
        };
      }

      // 상품별 최고 입찰가 객체에 값 세팅
      userStatus.rows.forEach(({ prod_key, bidprice }) => {
        auctionUserStatus[auctionId][socket.id].bids[prod_key] = bidprice;
      });

      // hostSocketId = targetSocketId; // 전역에 저장
      callback({ joined: true, hostSocketId: targetSocketId, userCount, hostLoginId, chats, selectProduct });

      // 4) 방 전체에 현재 사용자 상태 방송 (필요시)
      io.to(auctionId).emit('user-status-update', auctionUserStatus[auctionId]);

      // 경매당 실시간 시청자수 반환
      emitGuestCount(auctionId);
    } catch (e) {
      console.error('Failed to fetch host info:', e);
      callback({ e: 'Internal server error' });
    }
  });


  /////////////////////////////////////////////
  //              [ 라우터 생성 ]             //
  ////////////////////////////////////////////
  socket.on('create-router', (_, callback) => {
    callback({ rtpCapabilities: router.rtpCapabilities })
  })

  //////////////////////////////////////////////
  //            [trasnport 생성]              //
  /////////////////////////////////////////////
  socket.on('create-transport', async ({ direction }, callback) => {
    try {
      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: 'bidcastserver.kro.kr' }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1000000,
        portRange: { min: 40000, max: 40010 },
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls: 'turn:bidcastserver.kro.kr:3478',
            username: 'webrtc',
            credential: '1234'
          }
        ],
      })
      transports.set(transport.id, { transport, socketId: socket.id, direction })
      console.log(`Transport created [${direction}]:`, transport.id)

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      })
    } catch (e) {
      console.error(e)
      callback({ error: e.message })
    }
  })

  ///////////////////////////////////////
  //            [transport 연결]        //       
  ///////////////////////////////////////
  socket.on('connect-transport', async ({ dtlsParameters, transportId }, callback) => {
    try {
      const data = transports.get(transportId)
      if (!data) throw new Error('Transport not found')
      await data.transport.connect({ dtlsParameters })
      console.log(`Transport connected: ${transportId}`)
      callback()
    } catch (e) {
      console.error(e)
      callback({ error: e.message })
    }
  })


  //////////////////////////////////////////////////
  //                [비디오 송출버튼 클릭]          //
  //////////////////////////////////////////////////
  socket.on('produce', async ({ kind, rtpParameters, transportId, roomId }, callback) => {
    try {
      const data = transports.get(transportId)
      if (!data) throw new Error('Transport not found')

      const producer = await data.transport.produce({ kind, rtpParameters })

      // producer 저장 시 방 정보 포함
      // producers에 roomId에 해당하는 맵이 없다면 새로 생성성
      if (!producers.has(roomId)) producers.set(roomId, new Map())

      producers.get(roomId).set(producer.id, { producer, socketId: socket.id, kind })

      console.log('New producer:', producer.id)
      console.log('Total producers:', producers.size)  // 여기에 추가!

      console.log(`Emitting new-producer for producerId: ${producer.id} socketId: ${socket.id}`)
      const rooms = Array.from(socket.rooms).filter(r => r !== socket.id)
      rooms.forEach(room => {
        socket.broadcast.to(room).emit('new-producer', {
          producerId: producer.id,
          socketId: socket.id,
          // auctionId: roomId,  // 방 정보 추가
          kind
        })
      })

      callback({ id: producer.id })
    } catch (e) {
      console.error(e)
      callback({ error: e.message })
    }
  })

  /////////////////////////////////////////////////
  //     [다른 참여자들에게 비디오 보이게 하기]        //
  /////////////////////////////////////////////////
  socket.on('consume', async ({ producerId, rtpCapabilities, transportId, roomId }, callback) => {
    try {
      const data = transports.get(transportId)
      if (!data) throw new Error('Transport not found')


      const roomProducers = producers.get(roomId)
      if (!roomProducers || !roomProducers.has(producerId)) {
        throw new Error('Producer not found in this room')
      }

      if (!router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error('Cannot consume')
      }

      const consumer = await data.transport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      })

      consumers.set(consumer.id, { consumer, socketId: socket.id })

      console.log(`Consumer created for producerId: ${producerId} consumerId: ${consumer.id}`)

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      })
    } catch (e) {
      console.error(e)
      callback({ error: e.message })
    }
  })

  ///////////////////////////////////////////////////////////
  //            [일시 중지된 consumer 스트림 수신 재개]]       //
  ///////////////////////////////////////////////////////////
  socket.on('consumer-resume', async ({ consumerId }) => {
    const data = consumers.get(consumerId)
    if (!data) {
      console.warn(`No consumer found to resume: ${consumerId}`)
      return
    }

    try {
      await data.consumer.resume()
      console.log(`Consumer resumed: ${consumerId}`)
    } catch (err) {
      console.error(`Failed to resume consumer ${consumerId}:`, err)
    }
  })
  ///////////////////////////
  // [ 현재 producer 받기 ] //
  ///////////////////////////
  socket.on('get-existing-producers', ({ roomId }, callback) => {
    const producersArray = []
    const roomProducers = producers.get(roomId)
    if (roomProducers) {
      for (const [producerId, data] of roomProducers) {
        producersArray.push({
          producerId,
          socketId: data.socketId,
          kind: data.kind
        })
      }
    }
    console.log("프로듀서 리스트 반환", producersArray)
    callback({ existingProducers: producersArray, hostSocketId: auctionHostMap.get(roomId) })
  })

  ////////////////////
  // [producer 삭제] //
  //////////////////// 
  socket.on('close-producer', ({ roomId }) => {
    const roomProducers = producers.get(roomId);
    if (!roomProducers) return;

    for (const [producerId, data] of roomProducers) {
      if (data.socketId === socket.id) {
        data.producer.close();
        roomProducers.delete(producerId);
        io.to(roomId).emit('user-disconnected', {
          socketId: socket.id,
          producerId
        });
        console.log(`Producer closed manually: ${producerId} in room ${roomId}`);
      }
    }

    if (roomProducers.size === 0) {
      producers.delete(roomId);
    }
  })

  ///////////////
  // [연결해제] //
  ///////////////
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id)

    const roomId = socketRoomMap.get(socket.id);
    if (roomId) {

      // 1) auctionUserStatus에서 삭제
      if (auctionUserStatus[roomId]) {
        delete auctionUserStatus[roomId][socket.id];

        // 2) 변경된 상태 방 전체 방송
        io.to(roomId).emit('user-status-update', auctionUserStatus[roomId]);
      }


      // 3. socket이 방에서 나가면 자동으로 rooms에서 제거됨
      const room = io.sockets.adapter.rooms.get(roomId);
      const userCount = room ? room.size : 0;

      console.log(`현재 유저수 : ${userCount}`);
      // 방 내 나머지 유저에게 인원수 업데이트 이벤트 발송
      io.to(roomId).emit('user-count-update', { auctionId: roomId, userCount });

      // 맵에서 삭제
      socketRoomMap.delete(socket.id);

      // 경매당 실시간 시청자수 반환
      emitGuestCount(roomId);
    }
    console.log(`Socket disconnected: ${socket.id}`);


    // Close and delete all transports for this socket
    for (const [transportId, data] of transports) {
      if (data.socketId === socket.id) {
        data.transport.close()
        transports.delete(transportId)
      }
    }
    // Close and delete all producers for this socket + notify others
    for (const [roomId, roomProducers] of producers) {
      for (const [producerId, data] of roomProducers) {
        if (data.socketId === socket.id) {
          data.producer.close()
          roomProducers.delete(producerId)
          io.emit('user-disconnected', {
            socketId: socket.id,
            producerId
          })
          console.log(`Producer closed manually: ${producerId}`)
        }
      }
      if (roomProducers.size === 0) {
        producers.delete(roomId)
      }
    }
    // Close and delete all consumers for this socket
    for (const [consumerId, data] of consumers) {
      if (data.socketId === socket.id) {
        data.consumer.close()
        consumers.delete(consumerId)
      }
    }

    // loginId 맵에서 삭제
    for (const [loginId, sId] of socketIdMap) {
      if (sId === socket.id) {
        socketIdMap.delete(loginId)
        break
      }
    }
  })
})

const PORT = 3000
httpServer.listen(PORT, () => {
  console.log(`Server running at http://bidcastserver.kro.kr`)
})
