const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

function processFile(data) {
  let buffer;
  let vertexCount = 0;
  let viewProj;

  // 6*4 + 4 + 4 = 8*4
  // XYZ - Position (Float32)
  // XYZ - Scale (Float32)
  // RGBA - colors (uint8)
  // IJKL - quaternion/rot (uint8)
  const rowLength = 3 * 4 + 3 * 4 + 4 + 4;
  let lastProj = [];
  let depthIndex = new Uint32Array();

  function runSort(viewProj) {
    if (!buffer) return;

    const f_buffer = new Float32Array(buffer);
    const u_buffer = new Uint8Array(buffer);

    const covA = new Float32Array(3 * vertexCount);
    const covB = new Float32Array(3 * vertexCount);

    const center = new Float32Array(3 * vertexCount);
    const color = new Float32Array(4 * vertexCount);

    if (depthIndex.length == vertexCount) {
      let dot =
        lastProj[2] * viewProj[2] +
        lastProj[6] * viewProj[6] +
        lastProj[10] * viewProj[10];
      if (Math.abs(dot - 1) < 0.01) {
        return;
      }
    }

    let maxDepth = -Infinity;
    let minDepth = Infinity;
    let sizeList = new Int32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      let depth =
        ((viewProj[2] * f_buffer[8 * i + 0] +
          viewProj[6] * f_buffer[8 * i + 1] +
          viewProj[10] * f_buffer[8 * i + 2]) *
          4096) |
        0;
      sizeList[i] = depth;
      if (depth > maxDepth) maxDepth = depth;
      if (depth < minDepth) minDepth = depth;
    }
    // console.time("sort");

    // This is a 16 bit two-pass radix sort

    // We simultaneously extract the first and second
    // bytes of the rescaled depths and accumulate
    // them into respective histograms
    let depthInv = (256 * 256) / (maxDepth - minDepth);
    let counts0 = new Uint32Array(256),
      counts1 = new Uint32Array(256);
    for (let i = 0; i < vertexCount; i++) {
      sizeList[i] = ((sizeList[i] - minDepth) * depthInv) | 0;
      counts0[sizeList[i] & 0xff]++;
      counts1[(sizeList[i] >> 8) & 0xff]++;
    }
    // We construct starts0 and starts1 as the
    // cumulative sum of counts0 and counts1
    let starts0 = new Uint32Array(256),
      starts1 = new Uint32Array(256);
    for (let i = 1; i < 256; i++) {
      starts0[i] = starts0[i - 1] + counts0[i - 1];
      starts1[i] = starts1[i - 1] + counts1[i - 1];
    }
    // we run our first pass which sorts by the
    // least significant byte of the depth. We store
    // the remaining (most significant) byte into
    // value1 in order to save a lookup in next pass.
    let index0 = new Uint32Array(vertexCount);
    let value1 = new Uint8Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      let pos = starts0[sizeList[i] & 0xff]++;
      index0[pos] = i;
      value1[pos] = sizeList[i] >> 8;
    }
    // We perform our second and final pass by
    // sorting on the most significant depth byte here
    depthIndex = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      depthIndex[starts1[value1[i]]++] = index0[i];
    }

    lastProj = viewProj;
    // console.timeEnd("sort");
    for (let j = 0; j < vertexCount; j++) {
      const i = depthIndex[j];

      center[3 * j + 0] = f_buffer[8 * i + 0];
      center[3 * j + 1] = f_buffer[8 * i + 1];
      center[3 * j + 2] = f_buffer[8 * i + 2];

      color[4 * j + 0] = u_buffer[32 * i + 24 + 0] / 255;
      color[4 * j + 1] = u_buffer[32 * i + 24 + 1] / 255;
      color[4 * j + 2] = u_buffer[32 * i + 24 + 2] / 255;
      color[4 * j + 3] = u_buffer[32 * i + 24 + 3] / 255;

      let scale = [
        f_buffer[8 * i + 3 + 0],
        f_buffer[8 * i + 3 + 1],
        f_buffer[8 * i + 3 + 2],
      ];
      let rot = [
        (u_buffer[32 * i + 28 + 0] - 128) / 128,
        (u_buffer[32 * i + 28 + 1] - 128) / 128,
        (u_buffer[32 * i + 28 + 2] - 128) / 128,
        (u_buffer[32 * i + 28 + 3] - 128) / 128,
      ];

      const R = [
        1.0 - 2.0 * (rot[2] * rot[2] + rot[3] * rot[3]),
        2.0 * (rot[1] * rot[2] + rot[0] * rot[3]),
        2.0 * (rot[1] * rot[3] - rot[0] * rot[2]),

        2.0 * (rot[1] * rot[2] - rot[0] * rot[3]),
        1.0 - 2.0 * (rot[1] * rot[1] + rot[3] * rot[3]),
        2.0 * (rot[2] * rot[3] + rot[0] * rot[1]),

        2.0 * (rot[1] * rot[3] + rot[0] * rot[2]),
        2.0 * (rot[2] * rot[3] - rot[0] * rot[1]),
        1.0 - 2.0 * (rot[1] * rot[1] + rot[2] * rot[2]),
      ];

      // Compute the matrix product of S and R (M = S * R)
      const M = [
        scale[0] * R[0],
        scale[0] * R[1],
        scale[0] * R[2],
        scale[1] * R[3],
        scale[1] * R[4],
        scale[1] * R[5],
        scale[2] * R[6],
        scale[2] * R[7],
        scale[2] * R[8],
      ];

      covA[3 * j + 0] = M[0] * M[0] + M[3] * M[3] + M[6] * M[6];
      covA[3 * j + 1] = M[0] * M[1] + M[3] * M[4] + M[6] * M[7];
      covA[3 * j + 2] = M[0] * M[2] + M[3] * M[5] + M[6] * M[8];
      covB[3 * j + 0] = M[1] * M[1] + M[4] * M[4] + M[7] * M[7];
      covB[3 * j + 1] = M[1] * M[2] + M[4] * M[5] + M[7] * M[8];
      covB[3 * j + 2] = M[2] * M[2] + M[5] * M[5] + M[8] * M[8];
    }

    processFile({ covA, center, color, covB, viewProj }, [
      covA.buffer,
      center.buffer,
      color.buffer,
      covB.buffer,
    ]);

    // console.timeEnd("sort");
  }

  function processPlyBuffer(inputBuffer) {
    const ubuf = new Uint8Array(inputBuffer);
    // 10KB ought to be enough for a header...
    const header = new TextDecoder().decode(ubuf.slice(0, 1024 * 10));
    const header_end = "end_header\n";
    const header_end_index = header.indexOf(header_end);
    if (header_end_index < 0)
      throw new Error("Unable to read .ply file header");
    const vertexCount = parseInt(/element vertex (\d+)\n/.exec(header)[1]);
    console.log("Vertex Count", vertexCount);
    let row_offset = 0,
      offsets = {},
      types = {};
    const TYPE_MAP = {
      double: "getFloat64",
      int: "getInt32",
      uint: "getUint32",
      float: "getFloat32",
      short: "getInt16",
      ushort: "getUint16",
      uchar: "getUint8",
    };
    for (let prop of header
      .slice(0, header_end_index)
      .split("\n")
      .filter((k) => k.startsWith("property "))) {
      const [p, type, name] = prop.split(" ");
      const arrayType = TYPE_MAP[type] || "getInt8";
      types[name] = arrayType;
      offsets[name] = row_offset;
      row_offset += parseInt(arrayType.replace(/[^\d]/g, "")) / 8;
    }
    console.log("Bytes per row", row_offset, types, offsets);

    let dataView = new DataView(
      inputBuffer,
      header_end_index + header_end.length
    );
    let row = 0;
    const attrs = new Proxy(
      {},
      {
        get(target, prop) {
          if (!types[prop]) throw new Error(prop + " not found");
          return dataView[types[prop]](row * row_offset + offsets[prop], true);
        },
      }
    );

    console.time("calculate importance");
    let sizeList = new Float32Array(vertexCount);
    let sizeIndex = new Uint32Array(vertexCount);
    for (row = 0; row < vertexCount; row++) {
      sizeIndex[row] = row;
      if (!types["scale_0"]) continue;
      const size =
        Math.exp(attrs.scale_0) *
        Math.exp(attrs.scale_1) *
        Math.exp(attrs.scale_2);
      const opacity = 1 / (1 + Math.exp(-attrs.opacity));
      sizeList[row] = size * opacity;
    }
    console.timeEnd("calculate importance");

    console.time("sort");
    sizeIndex.sort((b, a) => sizeList[a] - sizeList[b]);
    console.timeEnd("sort");

    // 6*4 + 4 + 4 = 8*4
    // XYZ - Position (Float32)
    // XYZ - Scale (Float32)
    // RGBA - colors (uint8)
    // IJKL - quaternion/rot (uint8)
    const rowLength = 3 * 4 + 3 * 4 + 4 + 4;
    const buffer = new ArrayBuffer(rowLength * vertexCount);

    console.time("build buffer");
    for (let j = 0; j < vertexCount; j++) {
      row = sizeIndex[j];

      const position = new Float32Array(buffer, j * rowLength, 3);
      const scales = new Float32Array(buffer, j * rowLength + 4 * 3, 3);
      const rgba = new Uint8ClampedArray(
        buffer,
        j * rowLength + 4 * 3 + 4 * 3,
        4
      );
      const rot = new Uint8ClampedArray(
        buffer,
        j * rowLength + 4 * 3 + 4 * 3 + 4,
        4
      );

      if (types["scale_0"]) {
        const qlen = Math.sqrt(
          attrs.rot_0 ** 2 +
            attrs.rot_1 ** 2 +
            attrs.rot_2 ** 2 +
            attrs.rot_3 ** 2
        );

        rot[0] = (attrs.rot_0 / qlen) * 128 + 128;
        rot[1] = (attrs.rot_1 / qlen) * 128 + 128;
        rot[2] = (attrs.rot_2 / qlen) * 128 + 128;
        rot[3] = (attrs.rot_3 / qlen) * 128 + 128;

        scales[0] = Math.exp(attrs.scale_0);
        scales[1] = Math.exp(attrs.scale_1);
        scales[2] = Math.exp(attrs.scale_2);
      } else {
        scales[0] = 0.01;
        scales[1] = 0.01;
        scales[2] = 0.01;

        rot[0] = 255;
        rot[1] = 0;
        rot[2] = 0;
        rot[3] = 0;
      }

      position[0] = attrs.x;
      position[1] = attrs.y;
      position[2] = attrs.z;

      if (types["f_dc_0"]) {
        const SH_C0 = 0.28209479177387814;
        rgba[0] = (0.5 + SH_C0 * attrs.f_dc_0) * 255;
        rgba[1] = (0.5 + SH_C0 * attrs.f_dc_1) * 255;
        rgba[2] = (0.5 + SH_C0 * attrs.f_dc_2) * 255;
      } else {
        rgba[0] = attrs.red;
        rgba[1] = attrs.green;
        rgba[2] = attrs.blue;
      }
      if (types["opacity"]) {
        rgba[3] = (1 / (1 + Math.exp(-attrs.opacity))) * 255;
      } else {
        rgba[3] = 255;
      }
    }
    console.timeEnd("build buffer");
    return buffer;
  }

  if (data.ply) {
    vertexCount = 0;
    runSort(viewProj);
    buffer = processPlyBuffer(data.ply);
    vertexCount = Math.floor(buffer.byteLength / rowLength);
    processFile({ buffer: buffer });
  } else if (data.buffer) {
    const splatData = new Uint8Array(data.buffer);

    // Get the current directory where the script is running
    const currentDir = __dirname;

    // Calculate the path to the 'out' folder (one level up)
    const outFolderPath = path.join(currentDir, "..", "splat");

    // Check if the 'out' folder exists
    if (!fs.existsSync(outFolderPath)) {
      // If it doesn't exist, create it
      fs.mkdirSync(outFolderPath);
      console.log(`'splats' output folder created.`);
    }

    // Write the binary data to a new .splat file
    fs.writeFile(
      path.join(outFolderPath, `${filename}.splat`),
      Buffer.from(splatData),
      (err) => {
        if (err) {
          console.error(err);
        } else {
          console.log(`${filename}.ply converted to ${filename}.splat`);
        }
      }
    );
  }
}

let plyFilePath = process.argv[2];
let filename = null;

convertToSplat(plyFilePath);

function convertToSplat(filePath) {
  filename = path.basename(filePath, path.extname(filePath));
  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.error(err);
      return;
    }

    processFile({ ply: data.buffer });
  });
}

module.exports = {
  convertToSplat,
};
