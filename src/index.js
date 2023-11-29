const fs = require('fs/promises');
const mysql = require('mysql2/promise');
const path = require('path');


async function main() {
  const workdir = '/files'
  const files = await fs.readdir(workdir);

  console.log(`Found ${files.length} files in ${workdir}`);
  if (files.length === 0) {
    return;
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_SERVICE_NAME,
    user: process.env.DB_USER,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
  });

  console.log('Connected to DB');

  for (const file of files) {
    // lets find file in db
    const [rows] = await connection.execute(
      'SELECT sku FROM oc_product WHERE image_path = ?',
      [file]
    );

    if (rows.length === 0) {
      console.log(`[WARN] File ${file} not found in DB`);
      continue;
    }

    // rename file to new name
    const sku = rows[0].sku;
    const ext = path.extname(file);
    const newFileName = `${sku}${ext}`;
    console.log(`Renaming ${file} -> ${newFileName}`);

    await fs.rename(path.join(workdir, file), path.join(workdir, newFileName));
  }
}

main();
