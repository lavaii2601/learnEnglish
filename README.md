# learnEnglish

Ứng dụng web luyện tiếng Anh với giao diện theo từng trang (hash route), gồm 2 nhóm chính:

- Bài tập
- Thêm nguồn dữ liệu

## Tính năng bài tập

- Trắc nghiệm
- Nối từ với định nghĩa
- Điền vào chỗ trống
- Viết định nghĩa (chấm theo từ khóa)

Tất cả bài tập đều truy xuất đáp án đúng từ cơ sở dữ liệu SQLite thông qua backend API.

## Thêm nguồn (2 nhiệm vụ riêng)

- Nhiệm vụ 1: Thêm từ vựng
- Nhiệm vụ 2: Thêm câu hỏi + câu trả lời

Ngoài thêm mới, trang quản lý cho phép sửa và xóa dữ liệu cho:

- Từ vựng
- Câu hỏi cho từng loại bài tập

## Cơ sở dữ liệu

Ứng dụng sử dụng tệp SQLite tại thư mục data:

- data/english_lab.db

Cấu trúc gồm:

- vocabulary: danh sách từ vựng
- questions.mcq: câu hỏi trắc nghiệm
- questions.matching: cặp nối từ
- questions.fillBlank: câu điền chỗ trống
- questions.writing: đề viết + từ khóa

## Công nghệ

- Vite
- Vanilla JavaScript
- Node.js + Express
- SQLite
- CSS responsive cho desktop/mobile

## Chạy dự án

### Cách nhanh (không cần gõ nhiều lệnh)

Trên Windows, chỉ cần mở file quickstart.bat ở thư mục gốc dự án.

Nếu bạn dùng PowerShell trong VS Code, có thể chạy:

```powershell
.\quickstart.ps1
```

Tệp này sẽ tự động:

- Kiểm tra Node.js và npm
- Cài dependencies nếu chưa có
- Chạy npm run dev (frontend + backend)

### Cách thủ công

```bash
npm install
npm run dev
```

Lệnh trên sẽ chạy đồng thời:

- Frontend Vite
- Backend API tại http://localhost:3001

Nếu chỉ muốn chạy API:

```bash
npm run start:api
```

## Build production

```bash
npm run build
npm run preview
```
