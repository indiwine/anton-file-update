const fs = require('fs/promises');
const mysql = require('mysql2/promise');
const path = require('path');
const process = require('process');
const {google} = require('googleapis');
const {authenticate} = require('@google-cloud/local-auth');
require('dotenv').config();

// Set folder name to search images under
const FOLDER_TO_SEARCH_UNDER = 'ExpressDetal Prod';
// File to save images not found in mysql
const NOT_FOUND_IMAGE_FILE = 'not-found.log';
// File to save renamed images
const RENAME_LOG_FILE = 'rename.log';
// Set to true to not rename images
const DRY_RUN = false;
// Set to true to log operations to console
const LOG_OPERATIONS = false;


async function main() {
  console.log('Starting...')
  console.log('DRY_RUN', DRY_RUN);
  console.log('connection', process.env.DB_SERVICE_NAME, process.env.DB_USER, process.env.DB_NAME, process.env.DB_PASSWORD);
  // Connect to mysql database
  const connection = await mysql.createConnection({
    host: process.env.DB_SERVICE_NAME, user: process.env.DB_USER, database: process.env.DB_NAME, password: process.env.DB_PASSWORD,
  });

  console.log('CWD', process.cwd());

  // Setup constants
  // If modifying these scopes, delete token.json.
  const SCOPES = ['https://www.googleapis.com/auth/drive'];
  // The file token.json stores the user's access and refresh tokens, and is
  // created automatically when the authorization flow completes for the first
  // time.
  const TOKEN_PATH = path.join(process.cwd(), 'token.json');
  const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
  const NOT_FOUND_IMAGE_PATH = path.join(process.cwd(), NOT_FOUND_IMAGE_FILE);

  // Open txt file for writing
  const notFoundImageFile = await fs.open(NOT_FOUND_IMAGE_PATH, 'w+');

  // Total number of retries triggered by the library.
  let numOfRetriesTriggered = 0;

  /**
   * Reads previously authorized credentials from the save file.
   *
   * @return {Promise<OAuth2Client|null>}
   */
  async function loadSavedCredentialsIfExist() {
    try {
      const content = await fs.readFile(TOKEN_PATH);
      const credentials = JSON.parse(content);
      return google.auth.fromJSON(credentials);
    } catch (err) {
      console.error(`Load credentials file "${TOKEN_PATH}" failed with error:`, err);
      return null;
    }
  }

  /**
   * Serializes credentials to a file comptible with GoogleAUth.fromJSON.
   *
   * @param {OAuth2Client} client
   * @return {Promise<void>}
   */
  async function saveCredentials(client) {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
      type: 'authorized_user',
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    });
    await fs.writeFile(TOKEN_PATH, payload);
  }

  /**
   * Load or request or authorization to call APIs.
   *
   */
  async function authorize() {
    let client = await loadSavedCredentialsIfExist();
    if (client) {
      return client;
    }
    client = await authenticate({
      scopes: SCOPES,
      keyfilePath: CREDENTIALS_PATH,
    });
    if (client.credentials) {
      await saveCredentials(client);
    }
    return client;
  }

  const authClient = await authorize();
  const drive = google.drive({version: 'v3', auth: authClient});

  /**
   * Executes a function with retries.
   *
   * @template T
   * @param {() => Promise<T>} func - The function to execute.
   * @param {number} [retries=5] - The number of times to retry the function.
   * @param {number} [baseDelay=30000] - The base delay between retries in milliseconds.
   * @returns {Promise<T>} - The result of the function execution.
   * @throws {Error} - Throws an error if the retry limit is reached.
   */
  async function doWithRetry(func, retries = 5, baseDelay = 30000) {
    let delay = baseDelay;
    for (let retryCount = 0; retryCount < retries; retryCount++) {
      try {
        return await func();
      } catch (err) {
        numOfRetriesTriggered++;
        console.error(err);
        console.log(`Retrying in ${delay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = baseDelay * Math.pow(2, retryCount);
      }
    }
    throw new Error('Retry limit reached.');

  }

  async function* searchFolders(folderId = null, folderName = null) {
    if (!folderId && !folderName) {
      throw new Error('Either folderId or folderName must be provided.');
    }

    if (folderId && folderName) {
      throw new Error('Either folderId or folderName must be provided, not both.');
    }

    let folderQuery = `mimeType="application/vnd.google-apps.folder" and `;

    if (folderId) {
      folderQuery += `'${folderId}' in parents`;
    }

    if (folderName) {
      folderQuery += `name='${folderName}'`;
    }


    const folderParams = {
      pageSize: 10,
      fields: 'nextPageToken, files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      q: folderQuery,
    };

    let folderRes = await drive.files.list(folderParams);
    let folderFiles = folderRes.data.files;


    while (folderFiles.length) {
      for (const folderFile of folderFiles) {
        yield folderFile;
      }

      if (folderRes.data.nextPageToken) {
        folderParams.pageToken = folderRes.data.nextPageToken;
        folderRes = await drive.files.list(folderParams);
        folderFiles = folderRes.data.files;
      } else {
        folderFiles = [];
      }

    }
  }

  // Generator function to recursively search for images
  async function* searchImages(folderId) {
    const imageQuery = `mimeType contains 'image/' and '${folderId}' in parents`;
    const imageParams = {
      pageSize: 10,
      fields: 'nextPageToken, files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      q: imageQuery,
    };
    let imageRes = await drive.files.list(imageParams);
    let imageFiles = imageRes.data.files;
    while (imageFiles.length) {
      for (const imageFile of imageFiles) {
        yield imageFile;
      }
      if (imageRes.data.nextPageToken) {
        imageParams.pageToken = imageRes.data.nextPageToken;
        imageRes = await drive.files.list(imageParams);
        imageFiles = imageRes.data.files;
      } else {
        imageFiles = [];
      }
    }
  }

  // Find image by name in mysql oc_product table and rename it with sku or write to file if not found
  async function findImageInDb(imageName) {
    const imageQuery = `SELECT sku
                        FROM oc_product
                        WHERE image_path = '${imageName}'`;
    const [rows, fields] = await connection.execute(imageQuery);
    if (rows.length) {
      const sku = rows[0].sku;

      if (LOG_OPERATIONS) {
        console.log(`Image "${imageName}" found with sku ${sku}.`);
      }

      return sku;
    } else {
      if (LOG_OPERATIONS) {
        console.log(`Image "${imageName}" not found.`);
      }
      await notFoundImageFile.appendFile(`${imageName}\n`);
      return null;
    }
  }

  let totalImages = 0;
  let renamedImages = 0;
  let notFoundImages = 0;
  // A recursive function to search for images and folders
  async function search(folderId) {
    for await (const folder of searchFolders(folderId)) {
      console.log(`Found folder: ${folder.name} with id ${folder.id}`);
      await search(folder.id);
    }

    for await (const image of searchImages(folderId)) {
      if (LOG_OPERATIONS) console.log(`Found image: ${image.name} with id ${image.id}`);

      totalImages++;
      const sku = await findImageInDb(image.name);
      if (!sku) {
        notFoundImages++;
      }

      if (sku) {
        const newImageName = `${sku}${path.extname(image.name)}`;
        const imageMetadata = {
          name: newImageName,
        };
        const imageParams = {
          fileId: image.id,
          resource: imageMetadata,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        };
        if (LOG_OPERATIONS) console.log(`Renaming image "${image.name}" to "${newImageName}".`);

        // Write to log file
        await fs.appendFile(RENAME_LOG_FILE, `${image.name} -> ${newImageName}\n`);
        if (!DRY_RUN) {
          await doWithRetry(() => drive.files.update(imageParams));
          renamedImages++;
        }

      }
    }
  }

  setInterval(() => {
    console.log('Renamed images', renamedImages, 'Not found images', notFoundImages, 'Total images', totalImages, 'Retries triggered', numOfRetriesTriggered);
  }, 10000);

  // Find folder to search under
  const folderGenerator = await searchFolders(null, FOLDER_TO_SEARCH_UNDER);
  const folder = await folderGenerator.next();
  await search(folder.value.id);

  // Close txt file
  await notFoundImageFile.close();

}

main().then(() => console.log('Done.')).catch(console.error).finally(() => process.exit());
