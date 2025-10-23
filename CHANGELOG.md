# Changelog - Bot Telegram Multi-Channel

## Update Terbaru - 20 Oktober 2025 (v2.0)

### ✨ Fitur Baru

#### 1. **Multiple Buttons/Links** 
Sekarang bot mendukung lebih dari satu tombol per pesan!

**Format Lama (masih didukung):**
```json
{
  "button_text": "DAFTAR",
  "button_url": "https://link.com"
}
```

**Format Baru (multiple buttons):**
```json
{
  "buttons": [
    {"text": "𝐃𝐀𝐅𝐓𝐀𝐑", "url": "https://link1.com"},
    {"text": "📱 𝐂𝐇𝐀𝐓 𝐀𝐃𝐌𝐈𝐍", "url": "https://t.me/support"},
    {"text": "🎮 𝐏𝐑𝐎𝐌𝐎", "url": "https://promo.com"}
  ]
}
```

#### 2. **Auto-Delete Pesan Lama**
- Setiap kali bot mengirim pesan baru, pesan lama di channel akan **otomatis dihapus**
- Di channel hanya ada pesan hari ini saja
- Besok saat kirim pesan baru, pesan kemarin otomatis dihapus

#### 3. **Pencegahan Duplikasi**
- Jika bot restart/reboot dan mengirim pesan lagi di hari yang sama, pesan lama akan dihapus
- Hanya ada 1 pesan per hari per channel
- Tidak ada pesan duplikat

### 🔧 Cara Menggunakan Multiple Buttons

Edit file `channels_config.json` dan ganti `button_text` + `button_url` dengan `buttons`:

**Contoh:**
```json
{
  "id": "@namachannel",
  "name": "Nama Channel",
  "buttons": [
    {
      "text": "𝐃𝐀𝐅𝐓𝐀𝐑 & 𝐂𝐋𝐀𝐈𝐌 𝐁𝐎𝐍𝐔𝐒",
      "url": "https://rebrand.ly/link-daftar"
    },
    {
      "text": "📱 𝐂𝐇𝐀𝐓 𝐀𝐃𝐌𝐈𝐍",
      "url": "https://t.me/adminsupport"
    },
    {
      "text": "🎮 𝐋𝐈𝐇𝐀𝐓 𝐏𝐑𝐎𝐌𝐎",
      "url": "https://website.com/promo"
    }
  ]
}
```

### 📝 Catatan Penting

1. **Backward Compatibility**: Format lama (`button_text` dan `button_url`) masih didukung, jadi config lama Anda tetap berfungsi
2. **Permissions**: Bot harus punya izin untuk menghapus pesan di channel (Admin dengan "Delete messages" permission)
3. **History Format**: File history sekarang menyimpan `message_ids` untuk tracking pesan yang dikirim

### ✨ Fitur Admin Commands Baru

Bot sekarang dilengkapi dengan admin commands yang lengkap:

**Commands Baru:**
- `!delete @channel` - Hapus pesan lama di channel tertentu secara manual
- `!deleteall` - Hapus semua pesan lama di semua channel sekaligus
- `!list` atau `!channels` - Tampilkan daftar semua channel dengan detail (waktu posting, last run, dll)
- `/help` - Help yang telah diupdate dengan semua command baru

**Commands Yang Sudah Ada:**
- `!post @channel` - Posting manual ke channel tertentu
- `!postall` - Posting ke semua channel sekaligus
- `!status` - Cek status bot dan statistik
- `!add <nama>` - Upload media baru
- `!folders` - Lihat daftar folder
- `!start` / `!stop` - Kontrol scheduler
- `!setfolder <channel> <folder>` - Set folder channel

### 🔄 Cara Update Config Anda

**Update Otomatis:**
Semua 30 channel yang masih menggunakan format lama telah **otomatis diupdate** menjadi format 2 buttons! ✅

**Format Sekarang:**
Setiap channel sekarang punya 2 buttons:
1. Button pertama: Tombol daftar/claim bonus (dari config lama)
2. Button kedua: "💬 𝐊𝐎𝐍𝐓𝐀𝐊 𝐂𝐒" (link sementara sama dengan button 1)

**Cara Edit:**
Tinggal edit file `channels_config.json` dan ganti URL di button ke-2 sesuai kebutuhan Anda!

### 🐛 Bug Fixes
- Hapus duplikasi kode di fungsi `sendMediaToChannel`
- Perbaikan validasi format button
- Optimasi pengecekan file size sebelum upload

---

## Cara Kerja Fitur Baru

### Auto-Delete Flow:
1. Bot cek history untuk message_id yang tersimpan
2. Hapus semua pesan lama (jika ada)
3. Kirim pesan baru
4. Simpan message_id baru ke history
5. Besok ulangi dari langkah 1

### Anti-Duplikasi:
- Bot cek `last_run` di config
- Jika sudah posting hari ini, skip
- Jika restart dan posting lagi, hapus pesan lama dulu
- Simpan message_id yang baru

---

**Selamat menggunakan fitur baru! 🚀**
