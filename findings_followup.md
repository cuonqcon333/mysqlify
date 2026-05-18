# Follow-Up: Findings Status & Next Steps
**Date:** 2026-05-18  
**Context:** Chốt lại trạng thái các findings ban đầu sau các round vá lỗi Core & Schema và Relations & Eager Loading.

---

## 1. Đã Đóng Hoàn Toàn (Closed Completely)
Các mục này đã được fix triệt để, có behavior khớp với chuẩn (như Eloquent), và được verify thông qua test suite.
- **`[P0#1]` Custom PK / non-auto-increment:** Đã hỗ trợ tạo và cập nhật model sử dụng UUID/Snowflake sinh ra từ hook `creating`, không còn bị ghi đè bởi `insertId`.
- **`[P0#2]` Hydration & `fresh()` chạy mutator:** Đã sử dụng raw DB assignment (`Object.defineProperty`) cho toàn bộ load path, chặn đứng việc hash password 2 lần.
- **`[P0#3]` Alias write-path broken:** Alias giờ đã là live proxy có khả năng read/write round-trip đồng bộ với DB column, tự động ẩn trong `toJSON()`, và qua mặt chính xác `getDirty()`.
- **`[P0#4]` `orWhere` boolean logic execution order:** Chấm dứt việc tách biệt `_orWheres`. Command chain `where(a).orWhere(b).where(c)` giờ đây giữ nguyên cấu trúc tuần tự của SQL (`a OR b AND c`).
- **`[P1#5]` `restore()` update sai target & `_clone()` thiếu flags:** Chặn việc áp dụng filter `deleted_at IS NULL` lên tiến trình restore; clone bảo toàn transaction context.
- **`[P1#6]` `saving`/`saved` không kích hoạt, mất mutation:** Đã đồng bộ event order hoàn hảo với Laravel Eloquent (`saving` → `creating/updating`).
- **`[P1#7]` `migrateRollback` runtime crash:** Import function `existsSync` đúng chuẩn thay vì gọi method trên object rỗng.
- **`[P2#9]` Internal state drift:** `_attributes` và `_original` giờ đã luôn đồng bộ ngược lại với các property trên instance ngay sau khi `update()`.
- **`[P2#10]` Dotted columns in `orderBy`/`groupBy`:** Các Identifier chứa dấu chấm (như `users.status`) đã được bọc backtick chính xác (`users`.`status`).
- **`[BUGFIX] CURRENT_TIMESTAMP quoting bug`:** Sửa lỗi serialize các biểu thức mặc định động có dấu nháy đơn (`'CURRENT_TIMESTAMP'`) gây lỗi trên real database. Đã fix tại `src/schema-builder.js` ([Line 110-123](file:///c:/Users/Admin/Desktop/Tabbala/active/mysqlify/src/schema-builder.js#L110-L123)), kiểm chứng qua smoke test tại `tests/integration/smoke.test.js` ([Line 38](file:///c:/Users/Admin/Desktop/Tabbala/active/mysqlify/tests/integration/smoke.test.js#L38)).

---

## 2. Đóng Một Phần / Phạm Vi Hẹp (Closed Partially / Closed Within Audited Scope)
Các mục này đã được fix một số tính năng trọng yếu để hệ thống hoạt động, nhưng bộ tính năng chung quanh chưa hoàn chỉnh.
- **`[P1#8]` `Schema.table()` silently drops constraints:** 
  - **Đã đóng (Closed within audited scope):** Biên dịch thành công các alter queries cho `ADD COLUMN`, `ADD UNIQUE KEY`, `ADD KEY`, `ADD CONSTRAINT FOREIGN KEY`, cũng như các advanced operations `MODIFY COLUMN`, `DROP COLUMN`, và `RENAME COLUMN`.
  - **Caveats / Tương thích ngược:** Lệnh `RENAME COLUMN` dựa trên cú pháp gốc của MySQL 8.0+ / MariaDB 10.5.2+; có thể gây crash trên các engine phiên bản cũ hơn.
  - **Unsupported / Out of Scope:** Chưa hỗ trợ drop trực tiếp các ràng buộc khóa độc lập (`DROP PRIMARY KEY`, `DROP FOREIGN KEY`), đổi tên index (`renameIndex`), hay thay đổi cấu hình bảng tổng quát (`ENGINE=...`).
- **`[P1#11]` Relations & Eager Loading:**
  - **Đã đóng (Closed within audited scope):** Giải quyết dứt điểm lỗi property shadowing ở eager load lồng nhau (`with('posts.comments')`), duy trì kết nối proxy transaction (`_conn`) xuyên suốt lazy relation, eager load và lazy eager load (`load()`). Hỗ trợ đầy đủ constrained eager/lazy load (`with({ posts: q => q.where(...) })`, `load({ posts: q => q.where(...) })`).
  - **Non-Goals / Out of scope:** Chưa bao phủ các kiểu quan hệ nâng cao khác ngoài 4 loại cốt lõi (`hasOne`, `hasMany`, `belongsTo`, `belongsToMany`), các observer hooks phức tạp kích hoạt gián tiếp, hoặc logic so sánh thực thể nghiêm ngặt dựa vào `this.constructor` trực tiếp thay vì `instanceof`.

---

## 3. Các Hạng Mục Còn Mở (Remaining Open Items)
Đây là các hạng mục nên được đưa vào round kiến trúc hoặc round fix tiếp theo.
- **Model `fill()` Behavior:** Việc dùng `Object.assign` cho `fill()` vẫn kích hoạt mutators (đúng kỳ vọng của user payload). Tuy nhiên cần quy trình kiểm thử sâu trên các relation edge cases hoặc mass-assignment lớn để chắc chắn behavior này không đụng độ với các object lồng nhau.

---

## 4. Portability & Compatibility Findings
Các phát hiện về khả năng di động và độ tương thích ngữ nghĩa SQL trên các engine cơ sở dữ liệu khác nhau:

- **`[COMPAT#1]` RENAME COLUMN Alter Compatibility:**
  - **Trạng thái:** **Runtime-confirmed incompatibility below documented support floor** / **Closed within documented support scope** (xác nhận crash thực tế trên MySQL 5.7, chạy hoàn hảo trên MySQL 8.0+ / MariaDB 10.5+).
- **`[COMPAT#2]` `VALUES(col)` Deprecation in `upsertMany`:**
  - **Trạng thái:** **Runtime-confirmed deprecation warning** / **Accepted portability debt** (mitigated by docs; chấp nhận cảnh báo deprecation trên MySQL 8.0.20+ để duy trì tương thích ngược rộng rãi với MySQL 5.7+ / MariaDB).
- **`[COMPAT#3]` JSON Column support floor:**
  - **Trạng thái:** **Documented compatibility floor, runtime-verified on tested matrix** (đã kiểm chứng hoạt động chính xác trên MySQL 5.7 / 8.0 / MariaDB 10.5).
- **`[COMPAT#4]` `DEFAULT CURRENT_TIMESTAMP` on DATETIME:**
  - **Trạng thái:** **Documented compatibility floor, runtime-verified on tested matrix** (đã kiểm chứng hoạt động chính xác trên MySQL 5.7 / 8.0 / MariaDB 10.5 sau khi sửa lỗi quoting dynamic default).
