# learnEnglish

Ứng dụng web luyện tiếng Anh với giao diện theo từng trang (hash route), gồm 2 nhóm chính:

- Bài tập
- Thêm nguồn dữ liệu

## Tính năng bài tập

- Trắc nghiệm
- Nối từ với định nghĩa
- Điền vào chỗ trống
- Viết định nghĩa (mỗi dòng là 1 đáp án, chấm không cần đúng thứ tự)
- Liệt kê ý (mỗi dòng là 1 đáp án, chấm không cần đúng thứ tự)

Tất cả bài tập đều truy xuất đáp án đúng từ Supabase thông qua backend API.

## Thêm nguồn (2 nhiệm vụ riêng)

- Nhiệm vụ 1: Thêm từ vựng
- Nhiệm vụ 2: Thêm câu hỏi + câu trả lời

Ngoài thêm mới, trang quản lý cho phép sửa và xóa dữ liệu cho:

- Từ vựng
- Câu hỏi cho từng loại bài tập

## Cơ sở dữ liệu

Ứng dụng dùng Supabase Postgres.

Cấu trúc gồm:

- vocabulary: danh sách từ vựng
- questions.mcq: câu hỏi trắc nghiệm
- questions.matching: cặp nối từ
- questions.fillBlank: câu điền chỗ trống
- questions.writing: đề viết + danh sách đáp án mẫu theo dòng
- questions.listing: câu hỏi liệt kê + danh sách đáp án mẫu theo dòng

## Công nghệ

- Vite
- Vanilla JavaScript
- Node.js + Express
- Supabase Postgres
- CSS responsive cho desktop/mobile

## Chạy dự án

### Chuẩn bị Supabase (bắt buộc)

1. Tạo project trên Supabase.
2. Vào SQL Editor, chạy nội dung file `supabase/schema.sql`.
3. Tạo file `.env` ở thư mục gốc dự án và thêm:

```bash
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key
# Hoặc dùng key này cho backend (khuyến nghị khi deploy)
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
# Bật true nếu muốn tự seed dữ liệu mẫu khi backend khởi động
ENABLE_SAMPLE_SEED=false
```

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

## Deploy Vercel

### Cấu hình đã có sẵn

- Frontend build từ Vite (`dist`)
- API serverless tại `api/index.js`
- Rewrite `/api/*` về cùng một API function

### Các bước deploy

1. Push code lên GitHub.
2. Vào Vercel, import repository.
3. Framework preset có thể để `Other` hoặc để Vercel tự nhận diện.
4. Build Command: `npm run build`.
5. Output Directory: `dist`.
6. Deploy.

### Environment Variables trên Vercel

Thêm các biến sau trong Project Settings -> Environment Variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (khuyến nghị)

Bạn có thể dùng `SUPABASE_ANON_KEY`, nhưng để backend ghi dữ liệu ổn định thì nên dùng `SUPABASE_SERVICE_ROLE_KEY`.
