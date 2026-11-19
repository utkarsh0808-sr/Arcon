
const JSZip = require("jszip");
const { parseString } = require("@fast-csv/parse");
const logger = require("./logger");

const COMPLETED_STATUSES = new Set([
  "COMPLETED",
  "COMPLETED_WARNINGS",
  "COMPLETED_ERRORS",
]);

const FAILED_STATUSES = new Set([
  "FAILED",
  "ERROR",
  "ERRORS",
  "FAILURE",
  "CANCELED",
  "CANCELLED",
  "ABORTED",
]);

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);

const activeExports = new Map();

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isTransientNetworkError(error) {
  return Boolean(
    error?.connectionFailure ||
    TRANSIENT_NETWORK_CODES.has(error?.code) ||
    /getaddrinfo|network error|socket hang up|timed?\s*out/i.test(
      error?.message || ""
    )
  );
}

async function requestFusion(request, operation, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request();

      if (response.status >= 500 && attempt < attempts) {
        await wait(attempt * 1500);
        continue;
      }

      assertFusionResponse(response, operation);
      return response;
    } catch (error) {
      lastError = error;

      if (!isTransientNetworkError(error) || attempt === attempts) {
        break;
      }

      await wait(attempt * 1500);
    }
  }

  if (isTransientNetworkError(lastError)) {
    const error = new Error(
      `${operation} failed because the Oracle Fusion host became unreachable after ${attempts} attempts. ` +
      `${lastError.message}`
    );

    error.code = lastError.code;
    error.connectionFailure = true;

    throw error;
  }

  throw lastError;
}

function parseCsv(csvText) {
  return new Promise((resolve, reject) => {
    const rows = [];

    parseString(String(csvText || "").replace(/^\uFEFF/, ""), {
      headers: false,
      ignoreEmpty: false,
      trim: false,
    })
      .on("error", reject)
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows));
  });
}

async function collectCsvFiles(
  zipBuffer,
  prefix = "",
  context = "Oracle task package"
) {
  if (!Buffer.isBuffer(zipBuffer)) {
    zipBuffer = Buffer.from(zipBuffer);
  }

  if (zipBuffer.length < 22) {
    throw new Error(`${context}: Invalid or incomplete ZIP package.`);
  }

  let zip;

  try {
    const safeBuffer = Buffer.from(zipBuffer);

    zip = await JSZip.loadAsync(safeBuffer, {
      checkCRC32: true,
    });
  } catch (error) {
    logger.error(
      `ZIP parsing failed for ${context}: ${error.stack || error.message}`
    );

    const wrappedError = new Error(
      `${context}: Unable to read ZIP package. ` +
      `The package may be corrupted or incomplete.`
    );

    wrappedError.code = "INVALID_ORACLE_PACKAGE";

    wrappedError.details = {
      originalError: error.message,
      packageSize: zipBuffer.length,
    };

    throw wrappedError;
  }

  const files = [];

  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;

    const entryName = `${prefix}${entry.name}`;
    const lowerName = entry.name.toLowerCase();

    if (lowerName.endsWith(".csv")) {
      const csvText = await entry.async("string");

      files.push({
        name: entryName,
        rows: await parseCsv(csvText),
      });
    } else if (lowerName.endsWith(".zip")) {
      const nestedBuffer = await entry.async("nodebuffer");

      files.push(
        ...(await collectCsvFiles(
          nestedBuffer,
          `${entryName}/`,
          `${context} / ${entry.name}`
        ))
      );
    }
  }

  return files;
}

function assertFusionResponse(response, operation) {
  if (response.status >= 200 && response.status < 300) return;

  const preview = JSON.stringify(response.data || {}).slice(0, 500);

  const error = new Error(
    `${operation} failed with HTTP ${response.status}. ${preview}`
  );

  error.status = response.status;

  throw error;
}

// function readProcessId(data) {
//   return (
//     data?.SetupTaskCSVExportProcess?.[0]?.ProcessId ||
//     data?.ProcessId
//   );
// }


function readProcessId(data) {
  return (
    data?.SetupTaskCSVExportProcess?.items?.[0]?.ProcessId ||
    data?.SetupTaskCSVExportProcess?.[0]?.ProcessId ||
    data?.ProcessId ||
    data?.items?.[0]?.ProcessId ||
    null
  );
}


function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function readStatus(data) {
  return normalizeStatus(
    data?.StatusCode ||
    data?.ProcessStatus ||
    data?.Status ||
    data?.ProcessStatusCode
  );
}

function readCompletedFlag(data) {
  return normalizeStatus(data?.ProcessCompletedFlag);
}

async function startTaskExport(client, task) {
  const response = await requestFusion(
    () =>
      client.post(
        "/fscmRestApi/resources/11.13.18.05/setupTaskCSVExports",
        {
          TaskCode: task.code,
          SetupTaskCSVExportProcess: [
            { TaskCode: task.code },
          ],
        }
      ),
    `Starting export for ${task.name}`
  );

  let processId = readProcessId(response.data);

  logger.info(
    `Oracle export creation response for ${task.name}: ` +
    `${JSON.stringify(response.data).slice(0, 2000)}`
  );

  if (processId) return processId;

  if (response.data?.ExportSupportedFlag === "N") {
    throw new Error(
      `Oracle reports that CSV export is not supported for ${task.name}.`
    );
  }

  logger.info(
    `Oracle did not create a nested process for ${task.name}; ` +
    `trying the child export-process endpoint.`
  );

  const processResponse = await requestFusion(
    () =>
      client.post(
        `/fscmRestApi/resources/11.13.18.05/setupTaskCSVExports/${encodeURIComponent(task.code)}` +
        "/child/SetupTaskCSVExportProcess",
        { TaskCode: task.code }
      ),
    `Creating child export process for ${task.name}`
  );

  processId = readProcessId(processResponse.data);

  if (!processId) {
    const responseFields =
      Object.keys(processResponse.data || {}).join(", ") || "none";

    throw new Error(
      `Oracle did not return an export process ID for ${task.name}, ` +
      `including from the child process endpoint. ` +
      `Response fields: ${responseFields}.`
    );
  }

  return processId;
}

async function pollTaskExport(client, cfg, task, processId) {
  const timeoutMs = Math.max(
    60000,
    Number(cfg.taskExportTimeoutMs) || 1800000
  );

  const pollMs = Math.max(
    1000,
    Number(cfg.taskExportPollMs) || 10000
  );

  const encodedProcessId = encodeURIComponent(processId);

  const processPath =
    `/fscmRestApi/resources/11.13.18.05/setupTaskCSVExports/${encodeURIComponent(task.code)}` +
    `/child/SetupTaskCSVExportProcess/${encodedProcessId}`;

  const resultPath =
    `${processPath}/child/SetupTaskCSVExportProcessResult/${encodedProcessId}`;

  const deadline = Date.now() + timeoutMs;

  let lastCompletedFlag = "N";
  let lastProcessStatus = "UNKNOWN";
  let lastResultStatus = "NOT_STARTED";
  let lastLoggedState = "";

  logger.info(
    `Polling Oracle export for ${task.name}. ` +
    `Process ID: ${processId}, ` +
    `Timeout: ${timeoutMs / 60000} minutes, ` +
    `Interval: ${pollMs}ms`
  );

  while (Date.now() < deadline) {
    const processResponse = await requestFusion(
      () => client.get(processPath),
      `Checking export process for ${task.name}`
    );

    const processData = processResponse.data || {};

    lastCompletedFlag =
      readCompletedFlag(processData) || lastCompletedFlag;

    lastProcessStatus =
      readStatus(processData) || lastProcessStatus;

    let resultResponse = null;

    try {
      resultResponse = await requestFusion(
        () => client.get(resultPath),
        `Checking export result for ${task.name}`
      );
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }

    const resultData = resultResponse?.data || {};

    if (resultData.StatusCode) {
      lastResultStatus = readStatus(resultData);
    }

    const currentState =
      `Process=${lastProcessStatus}, ` +
      `Result=${lastResultStatus}, ` +
      `Complete=${lastCompletedFlag}`;

    if (currentState !== lastLoggedState) {
      logger.info(
        `Oracle export status for ${task.name}: ${currentState}`
      );

      logger.info(
        `Oracle process response for ${task.name}: ` +
        JSON.stringify(processData).slice(0, 1500)
      );

      if (resultResponse) {
        logger.info(
          `Oracle result response for ${task.name}: ` +
          JSON.stringify(resultData).slice(0, 1500)
        );
      }

      lastLoggedState = currentState;
    }

    const normalizedProcessStatus = normalizeStatus(lastProcessStatus);
    const normalizedResultStatus = normalizeStatus(lastResultStatus);

    if (
      FAILED_STATUSES.has(normalizedProcessStatus) ||
      FAILED_STATUSES.has(normalizedResultStatus)
    ) {
      throw new Error(
        `Oracle export failed for ${task.name}. ` +
        `Process status: ${lastProcessStatus}; ` +
        `Result status: ${lastResultStatus}; ` +
        `Process ID: ${processId}.`
      );
    }

   if (
  COMPLETED_STATUSES.has(normalizedResultStatus) &&
  ["Y", "TRUE", "1", ""].includes(lastCompletedFlag)
){
      logger.info(
        `Oracle export completed for ${task.name}. ` +
        `Process ID: ${processId}`
      );

      return {
        processPath,
        resultPath,
        status: normalizedResultStatus,
      };
    }

    const remainingTime = deadline - Date.now();

    if (remainingTime > 0) {
      await wait(Math.min(pollMs, remainingTime));
    }
  }

  const timeoutMinutes = Math.round(timeoutMs / 60000);

  logger.error(
    `Oracle export timeout for ${task.name}. ` +
    `Process ID: ${processId}, ` +
    `Process status: ${lastProcessStatus}, ` +
    `Result status: ${lastResultStatus}, ` +
    `Completed flag: ${lastCompletedFlag}`
  );

  throw new Error(
    `Oracle did not finish exporting ${task.name} within ` +
    `${timeoutMinutes} minutes. ` +
    `Last process status: ${lastProcessStatus}; ` +
    `last result status: ${lastResultStatus}; ` +
    `process complete flag: ${lastCompletedFlag}; ` +
    `Process ID: ${processId}. ` +
    `Check Oracle Fusion process logs for queued or stuck exports.`
  );
}

async function downloadTaskExport(client, task, resultPath) {
  const resultResponse = await requestFusion(
    () => client.get(resultPath),
    `Reading export result for ${task.name}`
  );

  if (normalizeStatus(resultResponse.data?.StatusCode) === "COMPLETED_ERRORS") {
    throw new Error(
      `Oracle completed the export for ${task.name} with errors.`
    );
  }

  let zipBuffer;

  if (resultResponse.data?.FileContent) {
    zipBuffer = Buffer.from(
      resultResponse.data.FileContent,
      "base64"
    );
  } else {
    const fileResponse = await requestFusion(
      () =>
        client.get(`${resultPath}/enclosure/FileContent`, {
          headers: {
            Accept: "application/octet-stream",
          },
          responseType: "arraybuffer",
        }),
      `Downloading export file for ${task.name}`
    );

    zipBuffer = Buffer.from(fileResponse.data);
  }

  const files = await collectCsvFiles(zipBuffer);

  if (!files.length) {
    throw new Error(
      `Oracle returned no CSV data files for ${task.name}.`
    );
  }

  return {
    files,
    packageBuffer: zipBuffer,
  };
}

async function runTaskExport(client, cfg, task) {
  logger.info(
    `Starting setup task export: ${task.name} (${task.code})`
  );

  const processId = await startTaskExport(client, task);

  const process = await pollTaskExport(
    client,
    cfg,
    task,
    processId
  );

  const { files, packageBuffer } = await downloadTaskExport(
    client,
    task,
    process.resultPath
  );

  logger.info(
    `Setup task export completed: ${task.name} (${files.length} CSV files)`
  );

  return {
    ...task,
    processId,
    files,
    packageBuffer,
  };
}

async function exportTaskCsv(client, cfg, task) {
  const exportKey = [
    cfg.baseUrl,
    cfg.username,
    task.code,
  ]
    .map((value) => String(value || "").toUpperCase())
    .join("|");

  const active = activeExports.get(exportKey);

  if (active) {
    logger.info(
      `Reusing active setup task export for ${task.name}; ` +
      `no duplicate Oracle process will be created.`
    );

    return active;
  }

  const pending = runTaskExport(client, cfg, task)
    .finally(() => activeExports.delete(exportKey));

  activeExports.set(exportKey, pending);

  return pending;
}

module.exports = {
  collectCsvFiles,
  exportTaskCsv,
  isTransientNetworkError,
  parseCsv,
  startTaskExport,
};
