
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const mongoose = require("mongoose");

const PACKAGE_DIRECTORY = path.resolve(
  process.env.ORACLE_PACKAGE_DIR ||
  path.join(__dirname, "..", "output", "oracle-packages")
);

const GRIDFS_BUCKET_NAME = "oracleTaskPackages";

function safePart(value) {
  return String(value || "TASK")
    .replace(/[^a-z0-9_-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "TASK";
}

function getPackageBucket() {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    throw new Error(
      "MongoDB must be connected before storing or reading Oracle task packages."
    );
  }

  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: GRIDFS_BUCKET_NAME,
  });
}

async function savePackageToGridFS(filename, buffer, metadata) {
  const bucket = getPackageBucket();
  const upload = bucket.openUploadStream(filename, { metadata });

  try {
    await new Promise((resolve, reject) => {
      upload.once("error", reject);
      upload.once("finish", resolve);
      upload.end(buffer);
    });

    return upload.id.toString();
  } catch (error) {
    if (upload.id) {
      await bucket.delete(upload.id).catch(() => {});
    }
    throw error;
  }
}

async function readPackageFromGridFS(fileId) {
  let objectId;

  try {
    objectId = new mongoose.Types.ObjectId(String(fileId));
  } catch {
    throw new Error("The stored Oracle task package reference is invalid.");
  }

  const download = getPackageBucket().openDownloadStream(objectId);
  const chunks = [];

  try {
    for await (const chunk of download) {
      chunks.push(chunk);
    }
  } catch (error) {
    if (
      error.code === "ENOENT" ||
      error.codeName === "FileNotFound"
    ) {
      const missing = new Error(
        "The stored Oracle task package is missing from MongoDB GridFS."
      );
      missing.code = "ORACLE_PACKAGE_MISSING";
      throw missing;
    }

    throw error;
  }

  return Buffer.concat(chunks);
}

async function storeTaskPackages(taskResults, runToken = Date.now()) {
  const packages = [];

  for (const task of taskResults || []) {
    if (
      !Buffer.isBuffer(task.packageBuffer) ||
      !task.packageBuffer.length ||
      !task.code
    ) {
      continue;
    }

    const filename =
      `${safePart(task.code)}_${safePart(runToken)}_${crypto.randomBytes(6).toString("hex")}.zip`;

    const sha256 = crypto
      .createHash("sha256")
      .update(task.packageBuffer)
      .digest("hex");

    const fileId = await savePackageToGridFS(
      filename,
      task.packageBuffer,
      {
        taskCode: task.code,
        taskName: task.name || "",
        sha256,
      }
    );

    packages.push({
      taskCode: task.code,
      taskName: task.name,
      filename,
      storage: "gridfs",
      fileId,
      sha256,
    });
  }

  return packages;
}

async function readTaskPackage(packageInfo) {
  let buffer;

  if (packageInfo?.storage === "gridfs" || packageInfo?.fileId) {
    buffer = await readPackageFromGridFS(packageInfo.fileId);
  } else {
    // Backward compatibility with older filesystem-based extractions.
    const filename = path.basename(
      String(packageInfo?.filename || "")
    );

    if (
      !filename ||
      filename !== packageInfo?.filename ||
      !/^[a-zA-Z0-9_.-]+\.zip$/.test(filename)
    ) {
      throw new Error(
        "The stored Oracle task package reference is invalid."
      );
    }

    try {
      buffer = await fs.readFile(
        path.join(PACKAGE_DIRECTORY, filename)
      );
    } catch (error) {
      if (error.code === "ENOENT") {
        const missing = new Error(
          "The stored Oracle task package is no longer available. Create a fresh extraction."
        );
        missing.code = "ORACLE_PACKAGE_MISSING";
        throw missing;
      }

      throw error;
    }
  }

  if (packageInfo.sha256) {
    const actual = crypto
      .createHash("sha256")
      .update(buffer)
      .digest("hex");

    if (actual !== packageInfo.sha256) {
      throw new Error(
        "The stored Oracle task package failed its integrity check."
      );
    }
  }

  return buffer;
}

module.exports = {
  readTaskPackage,
  storeTaskPackages,
};

// const crypto = require("crypto");
// const fs = require("fs/promises");
// const path = require("path");

// // const PACKAGE_DIRECTORY = path.join(__dirname, "..", "output", "oracle-packages");
// const PACKAGE_DIRECTORY = path.resolve(
//   process.env.ORACLE_PACKAGE_DIR ||
//   path.join(__dirname, "..", "output", "oracle-packages")
// );
// function safePart(value) {
//   return String(value || "TASK").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "TASK";
// }

// async function storeTaskPackages(taskResults, runToken = Date.now()) {
//   await fs.mkdir(PACKAGE_DIRECTORY, { recursive: true });
//   const packages = [];
//   for (const task of taskResults || []) {
//     if (!Buffer.isBuffer(task.packageBuffer) || !task.packageBuffer.length || !task.code) continue;
//     const filename = `${safePart(task.code)}_${safePart(runToken)}_${crypto.randomBytes(6).toString("hex")}.zip`;
//     await fs.writeFile(path.join(PACKAGE_DIRECTORY, filename), task.packageBuffer, { flag: "wx", mode: 0o600 });
//     packages.push({
//       taskCode: task.code,
//       taskName: task.name,
//       filename,
//       sha256: crypto.createHash("sha256").update(task.packageBuffer).digest("hex"),
//     });
//   }
//   return packages;
// }

// async function readTaskPackage(packageInfo) {
//   const filename = path.basename(String(packageInfo?.filename || ""));
//   if (!filename || filename !== packageInfo?.filename || !/^[a-zA-Z0-9_.-]+\.zip$/.test(filename)) {
//     throw new Error("The stored Oracle task package reference is invalid.");
//   }
//   const buffer = await fs.readFile(path.join(PACKAGE_DIRECTORY, filename));
//   if (packageInfo.sha256) {
//     const actual = crypto.createHash("sha256").update(buffer).digest("hex");
//     if (actual !== packageInfo.sha256) throw new Error("The stored Oracle task package failed its integrity check.");
//   }
//   return buffer;
// }

// module.exports = { readTaskPackage, storeTaskPackages };
