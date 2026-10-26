
require("dotenv").config();

console.log("SMTP CHECK:", {
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  userExists: Boolean(process.env.SMTP_USER),
  passwordExists: Boolean(process.env.SMTP_PASS),
  fromExists: Boolean(process.env.SMTP_FROM),
  passwordLength: process.env.SMTP_PASS?.length,
});

const express = require("express");
const cors = require("cors");
const { PrismaClient, Prisma } = require("@prisma/client");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());


function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      message: "Access token is required.",
    });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({
      message: "Authentication service is not configured.",
    });
  }

  jwt.verify(token, process.env.JWT_SECRET, (error, user) => {
    if (error) {
      return res.status(401).json({
        message: "Invalid or expired token.",
      });
    }

    req.user = user;
    next();
  });
}


function requireAdmin(req, res, next) {
  if (req.user.roleId !== 1) {
    return res.status(403).json({
      message: "Admin access is required.",
    });
  }

  next();
}

function requireSalesAndSupportAccess(req, res, next) {
  if (![1, 2, 3].includes(Number(req.user.roleId))) {
    return res.status(403).json({
      message: "Access to sales and support requests is required.",
    });
  }

  next();
}

function routeError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parsePositiveId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw routeError(`Invalid ${label}.`);
  }
  return id;
}

function parseDate(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw routeError(`${label} is required and must be a valid date.`);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw routeError(`${label} is required and must be a valid date.`);
  }
  return date;
}


function validateSaleHeader(body, partial = false) {
  const data = {};

  if (!partial || Object.hasOwn(body, "SaleDate")) {
    data.SaleDate = parseDate(body.SaleDate, "SaleDate");
  }

  if (!partial || Object.hasOwn(body, "PaymentMethod")) {
    if (
      typeof body.PaymentMethod !== "string" ||
      !body.PaymentMethod.trim() ||
      body.PaymentMethod.trim().length > 30
    ) {
      throw routeError(
        "PaymentMethod is required and must be 30 characters or fewer."
      );
    }

    const paymentMethod = body.PaymentMethod.trim();
    const allowedPaymentMethods = ["Cash", "Card"];

    if (!allowedPaymentMethods.includes(paymentMethod)) {
      throw routeError(
        "PaymentMethod must be Cash or Card."
      );
    }

    data.PaymentMethod = paymentMethod;
  }

  return data;
}

async function prepareSaleItems(transaction, items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    throw routeError("SaleItem must contain between 1 and 100 items.");
  }

  let total = new Prisma.Decimal(0);
  const saleItems = [];

  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw routeError("Each sale item must be an object.");
    }

    const hasBatchId = item.BatchId !== undefined && item.BatchId !== null;
    const hasOtherItemId = item.OtherItemId !== undefined && item.OtherItemId !== null;
    if (hasBatchId === hasOtherItemId) {
      throw routeError("Each sale item must reference exactly one batch or other item.");
    }

    if (!Number.isInteger(item.Quantity) || item.Quantity <= 0) {
      throw routeError("Each sale item quantity must be a positive integer.");
    }

    let batchId = null;
    let otherItemId = null;
    let sellingPrice;
    let purchasePrice;

    if (hasBatchId) {
      batchId = parsePositiveId(item.BatchId, "BatchId");
      const batch = await transaction.medicineBatch.findUnique({
        where: { BatchId: batchId },
      });
      if (!batch) {
        throw routeError(`Medicine batch ${batchId} was not found.`, 404);
      }
      sellingPrice = batch.SellingPrice;
      purchasePrice = batch.PurchasePrice;
    } else {
      otherItemId = parsePositiveId(item.OtherItemId, "OtherItemId");
      const otherItem = await transaction.otherItem.findUnique({
        where: { OtherItemId: otherItemId },
      });
      if (!otherItem) {
        throw routeError(`Other item ${otherItemId} was not found.`, 404);
      }
      sellingPrice = otherItem.SellingPrice;
      purchasePrice = otherItem.PurchasePrice;
    }

    const unitPrice = new Prisma.Decimal(sellingPrice);
    if (!unitPrice.greaterThan(0)) {
      throw routeError("Sale items must have a positive selling price.");
    }
    const subTotal = unitPrice.mul(item.Quantity).toDecimalPlaces(2);
    total = total.add(subTotal);

    saleItems.push({
      BatchId: batchId,
      OtherItemId: otherItemId,
      Quantity: item.Quantity,
      UnitPrice: unitPrice,
      SubTotal: subTotal,
      PurchasePriceAtSale: purchasePrice,
    });
  }

  if (total.greaterThan("99999999.99")) {
    throw routeError("Sale total exceeds the supported amount.");
  }

  return { saleItems, total };
}

function getColomboCalendarDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo",
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const dateParts = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
}

async function deductSaleInventory(transaction, saleItems) {
  const groupedItems = new Map();
  const maxDatabaseInt = 2147483647;

  for (const saleItem of saleItems) {
    const isMedicineBatch = saleItem.BatchId !== null;
    const itemId = isMedicineBatch ? saleItem.BatchId : saleItem.OtherItemId;
    const itemType = isMedicineBatch ? "MedicineBatch" : "OtherItem";
    const key = `${itemType}:${itemId}`;
    const groupedItem = groupedItems.get(key);
    const quantity = (groupedItem?.Quantity || 0) + saleItem.Quantity;

    if (!Number.isSafeInteger(quantity) || quantity > maxDatabaseInt) {
      throw routeError("Combined sale quantity exceeds the supported amount.");
    }

    groupedItems.set(key, { itemType, itemId, Quantity: quantity });
  }

  const medicineTransactions = [];
  const batchRecords = new Map();
  const otherItemRecords = new Map();
  const medicineIds = new Set();

  for (const groupedItem of groupedItems.values()) {
    if (groupedItem.itemType === "MedicineBatch") {
      const batch = await transaction.medicineBatch.findUnique({
        where: { BatchId: groupedItem.itemId },
      });

      if (!batch) {
        throw routeError(`Medicine batch ${groupedItem.itemId} was not found.`, 404);
      }
      if (!batch.IsActive) {
        throw routeError(`Medicine batch ${groupedItem.itemId} is inactive.`);
      }
      if (batch.Quantity < groupedItem.Quantity) {
        throw routeError(`Insufficient stock for medicine batch ${groupedItem.itemId}.`, 409);
      }

      batchRecords.set(groupedItem.itemId, groupedItem);
      medicineIds.add(batch.MedicineId);
      continue;
    }

    const otherItem = await transaction.otherItem.findUnique({
      where: { OtherItemId: groupedItem.itemId },
    });
    if (!otherItem) {
      throw routeError(`Other item ${groupedItem.itemId} was not found.`, 404);
    }
    if (!otherItem.Status) {
      throw routeError(`Other item ${groupedItem.itemId} is inactive.`);
    }
    if (otherItem.Quantity < groupedItem.Quantity) {
      throw routeError(`Insufficient stock for other item ${groupedItem.itemId}.`, 409);
    }

    otherItemRecords.set(groupedItem.itemId, groupedItem);
  }

  const orderedMedicineIds = [...medicineIds].sort((left, right) => left - right);
  if (orderedMedicineIds.length > 0) {
    const lockedMedicines = await transaction.$queryRaw`
      SELECT "MedicineId", "IsActive"
      FROM "Medicine"
      WHERE "MedicineId" IN (${Prisma.join(orderedMedicineIds)})
      ORDER BY "MedicineId" ASC
      FOR SHARE
    `;

    if (!Array.isArray(lockedMedicines) || lockedMedicines.length !== orderedMedicineIds.length) {
      throw routeError("Could not lock all medicines for this sale.", 409);
    }
    if (lockedMedicines.some((medicine) => medicine.IsActive !== true)) {
      throw routeError("One or more medicines are inactive.");
    }
  }

  
  for (const [batchId, groupedItem] of [...batchRecords].sort(([left], [right]) => left - right)) {
    const updatedBatches = await transaction.$queryRaw`
      UPDATE "MedicineBatch" AS batch
      SET "Quantity" = batch."Quantity" - ${groupedItem.Quantity}
      WHERE batch."BatchId" = ${batchId}
        AND batch."IsActive" = true
        AND batch."Quantity" >= ${groupedItem.Quantity}
        AND (
          batch."ExpiryDate" IS NULL
          OR batch."ExpiryDate" >= (statement_timestamp() AT TIME ZONE 'Asia/Colombo')::date
        )
        AND EXISTS (
          SELECT 1
          FROM "Medicine" AS medicine
          WHERE medicine."MedicineId" = batch."MedicineId"
            AND medicine."IsActive" = true
        )
      RETURNING batch."BatchId", batch."Quantity"
    `;

    if (!Array.isArray(updatedBatches) || updatedBatches.length !== 1) {
      throw routeError(
        `Medicine batch ${batchId} stock or eligibility changed.`,
        409
      );
    }

    medicineTransactions.push({
      BatchId: updatedBatches[0].BatchId,
      Quantity: updatedBatches[0].Quantity,
    });
  }


  for (const [otherItemId, groupedItem] of [...otherItemRecords].sort(([left], [right]) => left - right)) {
    const updateResult = await transaction.otherItem.updateMany({
      where: {
        OtherItemId: otherItemId,
        Status: true,
        Quantity: { gte: groupedItem.Quantity },
      },
      data: {
        Quantity: { decrement: groupedItem.Quantity },
      },
    });

    if (updateResult.count !== 1) {
      throw routeError(
        `Other item ${otherItemId} stock or status changed.`,
        409
      );
    }
  }

  return medicineTransactions;
}

function validateSupportRequest(body, partial = false) {
  const data = {};
  for (const field of ["RequestType", "Message", "Status"]) {
    if (partial && !Object.hasOwn(body, field)) continue;

    const maxLength = field === "RequestType" ? 50 : field === "Status" ? 30 : null;
    const value = body[field];
    if (typeof value !== "string" || !value.trim() || (maxLength && value.trim().length > maxLength)) {
      throw routeError(`${field} is required${maxLength ? ` and must be ${maxLength} characters or fewer` : ""}.`);
    }
    data[field] = value.trim();
  }

  if (Object.hasOwn(body, "ResolvedAt")) {
    data.ResolvedAt = body.ResolvedAt === null
      ? null
      : parseDate(body.ResolvedAt, "ResolvedAt");
  }

  return data;
}


app.get("/api/protected-test", authenticateToken, (req, res) => {
  res.json({
    message: "Authentication successful.",
    userId: req.user.userId,
    userName: req.user.userName,
    roleId: req.user.roleId,
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "PharmaTrack Node API is running",
  });
});

app.get("/api/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      status: "OK",
      database: "Connected",
    });
  } catch (error) {
    console.error("Database connection error:", error.message);

    res.status(500).json({
      status: "ERROR",
      database: "Disconnected",
    });
  }
});


app.get(
  "/api/admin-test",
  authenticateToken,
  requireAdmin,
  (req, res) => {
    res.json({
      message: "Admin authorization successful.",
      userId: req.user.userId,
      userName: req.user.userName,
      roleId: req.user.roleId,
    });
  }
);


app.get("/api/Medicine", authenticateToken, async (req, res) => {

  try {
    const medicines = await prisma.medicine.findMany({
      orderBy: {
        Name: "asc",
      },
    });
    console.log("Medicine records from database:", medicines.length);

    res.json(medicines);
  } catch (error) {
    console.error("Failed to load medicines:", error.message);

    res.status(500).json({
      message: "Failed to load medicines",
    });
  }
});

app.post("/api/Medicine", authenticateToken, async (req, res) => {
  try {
    const body = req.body || {};

    const name = typeof body.Name === "string"
      ? body.Name.trim()
      : typeof body.name === "string"
        ? body.name.trim()
        : "";

    if (!name) {
      return res.status(400).json({
        message: "Medicine name is required.",
      });
    }

    const medicine = await prisma.medicine.create({
      data: {
        Name: name,
        GenericName: body.GenericName ?? body.genericName ?? null,
        Category: body.Category ?? body.category ?? null,
        Unit: body.Unit ?? body.unit ?? null,
        Strength: body.Strength ?? body.strength ?? null,
        IsActive: true,
      },
    });

    return res.status(201).json(medicine);
  } catch (error) {
    console.error("Failed to create medicine:", error.message);

    return res.status(500).json({
      message: "Failed to create medicine.",
    });
  }
});

app.put("/api/Medicine/:id", authenticateToken, async (req, res) => {
  try {
    const medicineId = Number(req.params.id);

    if (!Number.isInteger(medicineId) || medicineId <= 0) {
      return res.status(400).json({ message: "Invalid medicine ID." });
    }

    const body = req.body || {};

    const existing = await prisma.medicine.findUnique({
      where: { MedicineId: medicineId },
    });

    if (!existing) {
      return res.status(404).json({ message: "Medicine not found." });
    }

    const name = body.name ?? body.Name;
    const genericName = body.genericName ?? body.GenericName;
    const category = body.category ?? body.Category;
    const unit = body.unit ?? body.Unit;
    const strength = body.strength ?? body.Strength;

    if (
      typeof name !== "string" || !name.trim() ||
      typeof genericName !== "string" || !genericName.trim() ||
      typeof category !== "string" || !category.trim() ||
      typeof unit !== "string" || !unit.trim() ||
      typeof strength !== "string" || !strength.trim()
    ) {
      return res.status(400).json({
        message: "All medicine fields are required.",
      });
    }

    const medicine = await prisma.medicine.update({
      where: { MedicineId: medicineId },
      data: {
        Name: name.trim(),
        GenericName: genericName.trim(),
        Category: category.trim(),
        Unit: unit.trim(),
        Strength: strength.trim(),
      },
    });

    return res.json(medicine);
  } catch (error) {
    console.error("Failed to update medicine:", error.message);
    return res.status(500).json({
      message: "Failed to update medicine.",
    });
  }
});

app.delete("/api/Medicine/:id", authenticateToken, async (req, res) => {
  try {
    const medicineId = Number(req.params.id);

    if (!Number.isInteger(medicineId) || medicineId <= 0) {
      return res.status(400).json({ message: "Invalid medicine ID." });
    }

    const existing = await prisma.medicine.findUnique({
      where: { MedicineId: medicineId },
    });

    if (!existing) {
      return res.status(404).json({ message: "Medicine not found." });
    }

    if (!existing.IsActive) {
      return res.json({ message: "Medicine is already inactive." });
    }

    await prisma.medicine.update({
      where: { MedicineId: medicineId },
      data: { IsActive: false },
    });

    return res.json({ message: "Medicine deactivated successfully." });
  } catch (error) {
    console.error("Failed to deactivate medicine:", error.message);
    return res.status(500).json({
      message: "Failed to deactivate medicine.",
    });
  }
});
app.get("/api/MedicineBatch", authenticateToken, async (req, res) => {
  try {
    const batches = await prisma.medicineBatch.findMany({
      where: {
        IsActive: true,
      },
      include: {
        Medicine: true,
        Supplier: true,
      },
      orderBy: {
        BatchId: "desc",
      },
    });

    res.json(batches);
  } catch (error) {
    console.error("Failed to load medicine batches:", error.message);
    res.status(500).json({
      message: "Failed to load medicine batches",
    });
  }
});
// POST: Add a new medicine batch
app.post("/api/MedicineBatch", authenticateToken, async (req, res) => {
  try {
    const {
      medicineId,
      supplierId,
      batchName,
      manufacturingDate,
      expiryDate,
      purchasePrice,
      sellingPrice,
      quantity,
    } = req.body;

    if (!medicineId || !supplierId || !batchName?.trim()) {
      return res.status(400).json({
        message: "Medicine, supplier and batch name are required.",
      });
    }

    if (
      !manufacturingDate ||
      !expiryDate ||
      purchasePrice == null ||
      sellingPrice == null ||
      quantity == null
    ) {
      return res.status(400).json({
        message: "Please provide all batch details.",
      });
    }

    const mfgDate = new Date(manufacturingDate);
    const expDate = new Date(expiryDate);
    const purchase = Number(purchasePrice);
    const selling = Number(sellingPrice);
    const qty = Number(quantity);

    if (
      Number.isNaN(mfgDate.getTime()) ||
      Number.isNaN(expDate.getTime()) ||
      !Number.isFinite(purchase) ||
      !Number.isFinite(selling) ||
      !Number.isInteger(qty) ||
      qty < 0 ||
      purchase < 0 ||
      selling < 0
    ) {
      return res.status(400).json({
        message: "Please enter valid batch details.",
      });
    }

    const batch = await prisma.medicineBatch.create({
      data: {
        MedicineId: Number(medicineId),
        SupplierId: Number(supplierId),
        BatchName: batchName.trim(),
        ManufacturingDate: mfgDate,
        ExpiryDate: expDate,
        PurchasePrice: purchase,
        SellingPrice: selling,
        Quantity: qty,
        IsActive: true,
      },
      include: {
        Medicine: true,
        Supplier: true,
      },
    });

    return res.status(201).json(batch);
  } catch (error) {
    console.error("Failed to create medicine batch:", error);

    return res.status(500).json({
      message: "Failed to create medicine batch.",
    });
  }
});


// PUT: Edit an existing medicine batch
app.put("/api/MedicineBatch/:id", authenticateToken, async (req, res) => {
  try {
    const batchId = Number(req.params.id);

    if (!Number.isInteger(batchId) || batchId <= 0) {
      return res.status(400).json({
        message: "Invalid batch ID.",
      });
    }

    const existingBatch = await prisma.medicineBatch.findUnique({
      where: { BatchId: batchId },
    });

    if (!existingBatch) {
      return res.status(404).json({
        message: "Medicine batch not found.",
      });
    }

    const {
      medicineId,
      supplierId,
      batchName,
      manufacturingDate,
      expiryDate,
      purchasePrice,
      sellingPrice,
      quantity,
    } = req.body;

    const data = {};

    if (medicineId != null) data.MedicineId = Number(medicineId);
    if (supplierId != null) data.SupplierId = Number(supplierId);

    if (batchName != null) {
      if (!String(batchName).trim()) {
        return res.status(400).json({
          message: "Batch name is required.",
        });
      }
      data.BatchName = String(batchName).trim();
    }

    if (manufacturingDate != null) {
      const date = new Date(manufacturingDate);
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({
          message: "Invalid manufacturing date.",
        });
      }
      data.ManufacturingDate = date;
    }

    if (expiryDate != null) {
      const date = new Date(expiryDate);
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({
          message: "Invalid expiry date.",
        });
      }
      data.ExpiryDate = date;
    }

    if (purchasePrice != null) {
      const price = Number(purchasePrice);
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({
          message: "Invalid purchase price.",
        });
      }
      data.PurchasePrice = price;
    }

    if (sellingPrice != null) {
      const price = Number(sellingPrice);
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({
          message: "Invalid selling price.",
        });
      }
      data.SellingPrice = price;
    }

    // Quantity changes here should be reserved for editing batch details.
    // Use the AddStock endpoint for additional stock.
    if (quantity != null) {
      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty < 0) {
        return res.status(400).json({
          message: "Quantity must be a non-negative whole number.",
        });
      }
      data.Quantity = qty;
    }

    const updatedBatch = await prisma.medicineBatch.update({
      where: { BatchId: batchId },
      data,
      include: {
        Medicine: true,
        Supplier: true,
      },
    });

    return res.json(updatedBatch);
  } catch (error) {
    console.error("Failed to update medicine batch:", error);

    return res.status(500).json({
      message: "Failed to update medicine batch.",
    });
  }
});


// DELETE: Safely deactivate a medicine batch
app.delete(
  "/api/MedicineBatch/:id",
  authenticateToken,
  async (req, res) => {
    try {
      const batchId = Number(req.params.id);

      if (!Number.isInteger(batchId) || batchId <= 0) {
        return res.status(400).json({
          message: "Invalid batch ID.",
        });
      }

      const batch = await prisma.medicineBatch.findUnique({
        where: { BatchId: batchId },
      });

      if (!batch) {
        return res.status(404).json({
          message: "Medicine batch not found.",
        });
      }

      // Soft delete: preserve sales and stock transaction history.
      const updatedBatch = await prisma.medicineBatch.update({
        where: { BatchId: batchId },
        data: {
          IsActive: false,
        },
      });

      return res.json({
        message: "Medicine batch deactivated successfully.",
        batch: updatedBatch,
      });
    } catch (error) {
      console.error("Failed to deactivate medicine batch:", error);

      return res.status(500).json({
        message: "Failed to deactivate medicine batch.",
      });
    }
  }
);

 // GET: Medicine expiry alerts
app.get("/api/MedicineBatch/ExpiryAlerts", authenticateToken, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const next30Days = new Date(today);
    next30Days.setDate(next30Days.getDate() + 30);

    const batches = await prisma.medicineBatch.findMany({
      where: {
        IsActive: true,
        Quantity: {
          gt: 0,
        },
      },
      include: {
        Medicine: true,
        Supplier: true,
      },
      orderBy: {
        ExpiryDate: "asc",
      },
    });

    const expired = batches.filter((batch) => {
      const expiryDate = new Date(batch.ExpiryDate);
      expiryDate.setHours(0, 0, 0, 0);

      return expiryDate < today;
    });

    const expiringSoon = batches.filter((batch) => {
      const expiryDate = new Date(batch.ExpiryDate);
      expiryDate.setHours(0, 0, 0, 0);

      return expiryDate >= today && expiryDate <= next30Days;
    });

    return res.json({
      expiredCount: expired.length,
      expiringSoonCount: expiringSoon.length,
      expired,
      expiringSoon,
    });
  } catch (error) {
    console.error("Failed to load expiry alerts:", error);

    return res.status(500).json({
      message: "Failed to load expiry alerts.",
    });
  }
});


app.post(
  "/api/MedicineBatch/:id/AddStock",
  authenticateToken,
  async (req, res) => {
    try {
      const batchId = Number(req.params.id);
      const quantityToAdd = Number(req.body?.quantity);
      const note =
        typeof req.body?.note === "string"
          ? req.body.note.trim()
          : null;

      const userId = Number(req.user?.userId);

      if (!Number.isInteger(batchId) || batchId <= 0) {
        return res.status(400).json({ message: "Invalid batch ID." });
      }

      if (!Number.isInteger(quantityToAdd) || quantityToAdd <= 0) {
        return res.status(400).json({
          message: "Quantity to add must be a positive whole number.",
        });
      }

      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(401).json({
          message: "Logged-in user ID is missing. Please log in again.",
        });
      }

      if (note && note.length > 255) {
        return res.status(400).json({
          message: "Note cannot exceed 255 characters.",
        });
      }

      const result = await prisma.$transaction(async (tx) => {
        const batch = await tx.medicineBatch.findUnique({
          where: { BatchId: batchId },
        });

        if (!batch) {
          const error = new Error("Medicine batch not found.");
          error.statusCode = 404;
          throw error;
        }

        if (!batch.IsActive) {
          const error = new Error(
            "Cannot add stock to an inactive medicine batch."
          );
          error.statusCode = 400;
          throw error;
        }

        const updatedBatch = await tx.medicineBatch.update({
          where: { BatchId: batchId },
          data: {
            Quantity: { increment: quantityToAdd },
          },
          include: {
            Medicine: true,
            Supplier: true,
          },
        });

        const stockTransaction = await tx.stockTransaction.create({
          data: {
            BatchId: batchId,
            UserId: userId,
            TransactionType: "StockIn",
            Quantity: quantityToAdd,
            TransactionDate: new Date(),
            Note: note || "Additional stock received",
          },
        });

        return { updatedBatch, stockTransaction };
      });

      return res.json({
        message: "Stock added successfully.",
        batch: result.updatedBatch,
        transaction: result.stockTransaction,
      });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({
          message: error.message,
        });
      }

      console.error("Failed to add stock:", error);
      return res.status(500).json({
        message: "Failed to add stock.",
      });
    }
  }
);


/* GET SUPPLIERS */
app.get("/api/Supplier", authenticateToken, async (req, res) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      orderBy: {
        SupplierName: "asc",
      },
    });

    res.json(suppliers);
  } catch (error) {
    console.error("Failed to load suppliers:", error);
    res.status(500).json({
      message: "Failed to load suppliers.",
    });
  }
});


/* ADD SUPPLIER */
app.post("/api/Supplier", authenticateToken, async (req, res) => {
  try {
    const supplierName =
      req.body.supplierName ?? req.body.SupplierName;

    if (typeof supplierName !== "string" || !supplierName.trim()) {
      return res.status(400).json({
        message: "Supplier name is required.",
      });
    }

    const supplier = await prisma.supplier.create({
      data: {
        SupplierName: supplierName.trim(),
        ContactNumber:
          (req.body.contactNumber ?? req.body.ContactNumber)?.trim() || null,
        Email:
          (req.body.email ?? req.body.Email)?.trim() || null,
        Address:
          (req.body.address ?? req.body.Address)?.trim() || null,
        IsActive: true,
      },
    });

    return res.status(201).json(supplier);
  } catch (error) {
    console.error("Failed to add supplier:", error);
    return res.status(500).json({
      message: "Failed to add supplier.",
    });
  }
});


/* UPDATE SUPPLIER */
app.put("/api/Supplier/:id", authenticateToken, async (req, res) => {
  try {
    const supplierId = Number(req.params.id);
    const supplierName =
      req.body.supplierName ?? req.body.SupplierName;

    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      return res.status(400).json({
        message: "Invalid supplier ID.",
      });
    }

    if (typeof supplierName !== "string" || !supplierName.trim()) {
      return res.status(400).json({
        message: "Supplier name is required.",
      });
    }

    const updatedSupplier = await prisma.supplier.update({
      where: { SupplierId: supplierId },
      data: {
        SupplierName: supplierName.trim(),
        ContactNumber:
          (req.body.contactNumber ?? req.body.ContactNumber)?.trim() || null,
        Email:
          (req.body.email ?? req.body.Email)?.trim() || null,
        Address:
          (req.body.address ?? req.body.Address)?.trim() || null,
      },
    });

    return res.json(updatedSupplier);
  } catch (error) {
    console.error("Failed to update supplier:", error);

    if (error.code === "P2025") {
      return res.status(404).json({
        message: "Supplier not found.",
      });
    }

    return res.status(500).json({
      message: "Failed to update supplier.",
    });
  }
});


/* ACTIVATE / DEACTIVATE SUPPLIER */
app.patch(
  "/api/Supplier/:id/status",
  authenticateToken,
  async (req, res) => {
    try {
      const supplierId = Number(req.params.id);
      const isActive = req.body.isActive ?? req.body.IsActive;

      if (!Number.isInteger(supplierId) || supplierId <= 0) {
        return res.status(400).json({
          message: "Invalid supplier ID.",
        });
      }

      if (typeof isActive !== "boolean") {
        return res.status(400).json({
          message: "isActive must be true or false.",
        });
      }

      const supplier = await prisma.supplier.update({
        where: { SupplierId: supplierId },
        data: { IsActive: isActive },
      });

      return res.json({
        message: isActive
          ? "Supplier activated successfully."
          : "Supplier deactivated successfully.",
        supplier,
      });
    } catch (error) {
      console.error("Failed to change supplier status:", error);

      if (error.code === "P2025") {
        return res.status(404).json({
          message: "Supplier not found.",
        });
      }

      return res.status(500).json({
        message: "Failed to change supplier status.",
      });
    }
  }
);


/* DELETE SUPPLIER */
app.delete("/api/Supplier/:id", authenticateToken, async (req, res) => {
  try {
    const supplierId = Number(req.params.id);

    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      return res.status(400).json({
        message: "Invalid supplier ID.",
      });
    }

    const supplier = await prisma.supplier.findUnique({
      where: { SupplierId: supplierId },
    });

    if (!supplier) {
      return res.status(404).json({
        message: "Supplier not found.",
      });
    }

    const existingBatch = await prisma.medicineBatch.findFirst({
      where: { SupplierId: supplierId },
    });

    if (existingBatch) {
      return res.status(409).json({
        message:
          "This supplier is linked to stock batches. Deactivate the supplier instead of deleting it.",
      });
    }

    await prisma.supplier.delete({
      where: { SupplierId: supplierId },
    });

    return res.json({
      message: "Supplier deleted successfully.",
    });
  } catch (error) {
    console.error("Failed to delete supplier:", error);

    if (error.code === "P2003") {
      return res.status(409).json({
        message:
          "This supplier is linked to existing records and cannot be deleted.",
      });
    }

    return res.status(500).json({
      message: "Failed to delete supplier.",
    });
  }
});


app.get("/api/OtherItem", authenticateToken, async (req, res) => {

  try {
    const items = await prisma.otherItem.findMany({
      include: {
        ProductCategory: true,
      },
      orderBy: {
        ItemName: "asc",
      },
    });

    res.json(items);
  } catch (error) {
    console.error("Failed to load other items:", error.message);

    res.status(500).json({
      message: "Failed to load other items",
    });
  }
});


app.post("/api/OtherItem", authenticateToken, async (req, res) => {
  try {
    const {
      ItemName,
      Category,
      Unit,
      PurchasePrice,
      SellingPrice,
      Quantity,
      ReorderLevel,
      Status,
      ProductCategoryId,
    } = req.body;

    if (!ItemName?.trim()) {
      return res.status(400).json({
        message: "Item name is required.",
      });
    }

    const purchasePrice = Number(PurchasePrice);
    const sellingPrice = Number(SellingPrice);
    const quantity = Number(Quantity);
    const reorderLevel = Number(ReorderLevel);

    if (
      !Number.isFinite(purchasePrice) ||
      purchasePrice < 0 ||
      !Number.isFinite(sellingPrice) ||
      sellingPrice < 0 ||
      !Number.isInteger(quantity) ||
      quantity < 0 ||
      !Number.isInteger(reorderLevel) ||
      reorderLevel < 0
    ) {
      return res.status(400).json({
        message: "Please enter valid prices and quantities.",
      });
    }

    const item = await prisma.otherItem.create({
      data: {
        ItemName: ItemName.trim(),
        Category: Category || null,
        Unit: Unit || null,
        PurchasePrice: purchasePrice,
        SellingPrice: sellingPrice,
        Quantity: quantity,
        ReorderLevel: reorderLevel,
        Status: Status ?? true,
        ProductCategoryId:
          ProductCategoryId === "" ||
          ProductCategoryId === null ||
          ProductCategoryId === undefined
            ? null
            : Number(ProductCategoryId),
      },
      include: {
        ProductCategory: true,
      },
    });

    return res.status(201).json(item);
  } catch (error) {
    console.error("Failed to create other item:", error);

    return res.status(500).json({
      message: "Failed to save other item.",
    });
  }
});


app.put("/api/OtherItem/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: "Invalid item ID." });
    }

    const existing = await prisma.otherItem.findUnique({
      where: { OtherItemId: id },
    });

    if (!existing) {
      return res.status(404).json({ message: "Other item not found." });
    }

    const {
      ItemName,
      Category,
      Unit,
      PurchasePrice,
      SellingPrice,
      Quantity,
      ReorderLevel,
      Status,
      ProductCategoryId,
    } = req.body;

    const data = {};

    if (ItemName !== undefined) {
      if (typeof ItemName !== "string" || !ItemName.trim()) {
        return res.status(400).json({
          message: "Item name is required.",
        });
      }
      data.ItemName = ItemName.trim();
    }

    if (Category !== undefined) data.Category = Category || null;
    if (Unit !== undefined) data.Unit = Unit || null;

    if (PurchasePrice !== undefined) {
      const value = Number(PurchasePrice);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({
          message: "Invalid purchase price.",
        });
      }
      data.PurchasePrice = value;
    }

    if (SellingPrice !== undefined) {
      const value = Number(SellingPrice);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({
          message: "Invalid selling price.",
        });
      }
      data.SellingPrice = value;
    }

    if (Quantity !== undefined) {
      const value = Number(Quantity);
      if (!Number.isInteger(value) || value < 0) {
        return res.status(400).json({
          message: "Invalid quantity.",
        });
      }
      data.Quantity = value;
    }

    if (ReorderLevel !== undefined) {
      const value = Number(ReorderLevel);
      if (!Number.isInteger(value) || value < 0) {
        return res.status(400).json({
          message: "Invalid reorder level.",
        });
      }
      data.ReorderLevel = value;
    }

    if (Status !== undefined) data.Status = Status;

    if (ProductCategoryId !== undefined) {
      data.ProductCategoryId =
        ProductCategoryId === "" || ProductCategoryId === null
          ? null
          : Number(ProductCategoryId);
    }

    const updated = await prisma.otherItem.update({
      where: { OtherItemId: id },
      data,
      include: {
        ProductCategory: true,
      },
    });

    return res.json(updated);
  } catch (error) {
    console.error("Failed to update other item:", error);

    return res.status(500).json({
      message: "Failed to update other item.",
    });
  }
});


app.delete("/api/OtherItem/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: "Invalid item ID." });
    }

    const existing = await prisma.otherItem.findUnique({
      where: { OtherItemId: id },
    });

    if (!existing) {
      return res.status(404).json({ message: "Other item not found." });
    }

    await prisma.otherItem.delete({
      where: { OtherItemId: id },
    });

    return res.json({ message: "Other item deleted successfully." });
  } catch (error) {
    console.error("Failed to delete other item:", error);

    return res.status(500).json({
      message: "Failed to delete other item. It may be referenced by other records.",
    });
  }
});


app.get("/api/ProductCategory", authenticateToken, async (req, res) => {

  try {
    const categories = await prisma.productCategory.findMany({
      orderBy: {
        CategoryName: "asc",
      },
    });

    res.json(categories);
  } catch (error) {
    console.error("Failed to load product categories:", error.message);

    res.status(500).json({
      message: "Failed to load product categories",
    });
  }
});



app.get("/api/Sale", authenticateToken, requireSalesAndSupportAccess, async (req, res) => {

  try {
    const sales = await prisma.sale.findMany({
      include: {
        User: {
          select: {
            UserId: true,
            Name: true,
            UserName: true,
          },
        },
        SaleItem: true,
      },
      orderBy: {
        SaleId: "desc",
      },
    });

    res.json(sales);
  } catch (error) {
    console.error("Failed to load sales:", error.message);

    res.status(500).json({
      message: "Failed to load sales",
    });
  }
});



app.get("/api/Sale/:id", authenticateToken, requireSalesAndSupportAccess, async (req, res) => {

  try {
    const saleId = Number(req.params.id);

    if (!Number.isInteger(saleId) || saleId <= 0) {
      return res.status(400).json({
        message: "Invalid sale ID",
      });
    }

    const sale = await prisma.sale.findUnique({
      where: {
        SaleId: saleId,
      },
      include: {
        User: {
          select: {
            UserId: true,
            Name: true,
            UserName: true,
          },
        },
        SaleItem: {
          include: {
            MedicineBatch: {
              include: {
                Medicine: true,
              },
            },
          },
        },
      },
    });

    if (!sale) {
      return res.status(404).json({
        message: "Sale not found",
      });
    }

    res.json(sale);
  } catch (error) {
    console.error("Failed to load bill:", error.message);

    res.status(500).json({
      message: "Failed to load bill",
    });
  }
});

app.post("/api/Sale", authenticateToken, requireSalesAndSupportAccess, async (req, res) => {
  try {
    const body = req.body || {};
    const header = validateSaleHeader(body);
    const userId = parsePositiveId(req.user.userId, "authenticated user ID");
    const sale = await prisma.$transaction(async (transaction) => {
      const { saleItems, total } = await prepareSaleItems(transaction, body.SaleItem);
      const medicineTransactions = await deductSaleInventory(transaction, saleItems);
      const createdSale = await transaction.sale.create({
        data: {
          ...header,
          UserId: userId,
          TotalAmount: total,
          SaleItem: { create: saleItems },
        },
        include: {
          User: { select: { UserId: true, Name: true, UserName: true } },
          SaleItem: true,
        },
      });

      if (medicineTransactions.length > 0) {
        const transactionDate = new Date();
        await transaction.stockTransaction.createMany({
          data: medicineTransactions.map((medicineTransaction) => ({
            ...medicineTransaction,
            UserId: userId,
            TransactionType: "Sale",
            TransactionDate: transactionDate,
          })),
        });
      }

      return createdSale;
    });

    res.status(201).json(sale);
  } catch (error) {
    console.error("Failed to create sale:", error.message);
    res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : "Failed to create sale",
    });
  }
});

app.put("/api/Sale/:id", authenticateToken, requireSalesAndSupportAccess, async (req, res) => {
  try {
    const saleId = parsePositiveId(req.params.id, "sale ID");
    const body = req.body || {};
    const header = validateSaleHeader(body);
    const sale = await prisma.$transaction(async (transaction) => {
      const existing = await transaction.sale.findUnique({ where: { SaleId: saleId } });
      if (!existing) throw routeError("Sale not found.", 404);

      const { saleItems, total } = await prepareSaleItems(transaction, body.SaleItem);
      return transaction.sale.update({
        where: { SaleId: saleId },
        data: {
          ...header,
          TotalAmount: total,
          SaleItem: { deleteMany: {}, create: saleItems },
        },
        include: {
          User: { select: { UserId: true, Name: true, UserName: true } },
          SaleItem: true,
        },
      });
    });

    res.json(sale);
  } catch (error) {
    console.error("Failed to replace sale:", error.message);
    res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : "Failed to replace sale",
    });
  }
});

app.patch("/api/Sale/:id", authenticateToken, requireSalesAndSupportAccess, async (req, res) => {
  try {
    const saleId = parsePositiveId(req.params.id, "sale ID");
    const body = req.body || {};
    const header = validateSaleHeader(body, true);
    const hasItems = Object.hasOwn(body, "SaleItem");
    if (!hasItems && Object.keys(header).length === 0) {
      throw routeError("Provide SaleDate, PaymentMethod, or SaleItem to update.");
    }

    const sale = await prisma.$transaction(async (transaction) => {
      const existing = await transaction.sale.findUnique({
        where: { SaleId: saleId },
        include: { SaleItem: true },
      });
      if (!existing) throw routeError("Sale not found.", 404);

      const data = { ...header };
      if (hasItems) {
        const { saleItems, total } = await prepareSaleItems(transaction, body.SaleItem);
        data.TotalAmount = total;
        data.SaleItem = { deleteMany: {}, create: saleItems };
      }

      return transaction.sale.update({
        where: { SaleId: saleId },
        data,
        include: {
          User: { select: { UserId: true, Name: true, UserName: true } },
          SaleItem: true,
        },
      });
    });

    res.json(sale);
  } catch (error) {
    console.error("Failed to update sale:", error.message);
    res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : "Failed to update sale",
    });
  }
});

app.delete("/api/Sale/:id", authenticateToken, requireSalesAndSupportAccess, async (req, res) => {
  try {
    const saleId = parsePositiveId(req.params.id, "sale ID");
    await prisma.$transaction(async (transaction) => {
      const existing = await transaction.sale.findUnique({ where: { SaleId: saleId } });
      if (!existing) throw routeError("Sale not found.", 404);
      await transaction.saleItem.deleteMany({ where: { SaleId: saleId } });
      await transaction.sale.delete({ where: { SaleId: saleId } });
    });

    res.status(204).end();
  } catch (error) {
    console.error("Failed to delete sale:", error.message);
    res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : "Failed to delete sale",
    });
  }
});

app.get("/api/Role", authenticateToken, async (req, res) => {
  try {
    const roles = await prisma.role.findMany({
      orderBy: {
        RoleId: "asc",
      },
    });

    res.json(roles);
  } catch (error) {
    console.error("Failed to load roles:", error.message);

    res.status(500).json({
      message: "Failed to load roles",
    });
  }
});


app.get("/api/User", authenticateToken, requireAdmin, async (req, res) => {

  try {
    const users = await prisma.user.findMany({
      select: {
        UserId: true,
        Name: true,
        UserName: true,
        RoleId: true,
        Status: true,
        Email: true,
        Role: true,
      },
      orderBy: {
        UserId: "asc",
      },
    });

    res.json(users);
  } catch (error) {
    console.error("Failed to load users:", error.message);

    res.status(500).json({
      message: "Failed to load users",
    });
  }
});

function hashAspNetPassword(password) {
  const salt = crypto.randomBytes(16);
  const iterations = 100000;

  const subkey = crypto.pbkdf2Sync(
    password,
    salt,
    iterations,
    32,
    "sha512"
  );

  const header = Buffer.alloc(13);
  header[0] = 0x01;
  header.writeUInt32BE(2, 1);
  header.writeUInt32BE(iterations, 5);
  header.writeUInt32BE(salt.length, 9);

  return Buffer.concat([header, salt, subkey]).toString("base64");
}

/* ADD USER */
app.post(
  "/api/User",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const Name = req.body?.Name ?? req.body?.name;
const UserName = req.body?.UserName ?? req.body?.userName;
const Email = req.body?.Email ?? req.body?.email;
const Password = req.body?.Password ?? req.body?.password;
const RoleId = req.body?.RoleId ?? req.body?.roleId;
const Status = req.body?.Status ?? req.body?.status;

      if (
        typeof Name !== "string" ||
        !Name.trim() ||
        typeof UserName !== "string" ||
        !UserName.trim() ||
        typeof Password !== "string" ||
        !Password ||
        RoleId == null
      ) {
        return res.status(400).json({
          message: "Name, username, password and role are required.",
        });
      }

      if (Password.length < 6) {
        return res.status(400).json({
          message: "Password must be at least 6 characters.",
        });
      }

      const roleId = Number(RoleId);

      if (!Number.isInteger(roleId) || roleId < 1) {
        return res.status(400).json({
          message: "Please select a valid role.",
        });
      }

      const existingUser = await prisma.user.findUnique({
        where: { UserName: UserName.trim() },
      });

      if (existingUser) {
        return res.status(409).json({
          message: "This username is already in use.",
        });
      }

      const role = await prisma.role.findUnique({
        where: { RoleId: roleId },
      });

      if (!role) {
        return res.status(400).json({
          message: "Selected role does not exist.",
        });
      }

      // Use the existing ASP.NET Core Identity password hasher.
      // PasswordHasher must be defined/imported in your backend.
      const passwordHash = hashAspNetPassword(Password);

      const user = await prisma.user.create({
        data: {
          Name: Name.trim(),
          UserName: UserName.trim(),
          Email:
            typeof Email === "string" && Email.trim()
              ? Email.trim().toLowerCase()
              : null,
          Password: passwordHash,
          RoleId: roleId,
          Status: Status === undefined ? true : Boolean(Status),
        },
        select: {
          UserId: true,
          Name: true,
          UserName: true,
          Email: true,
          RoleId: true,
          Status: true,
        },
      });

      return res.status(201).json({
        message: "User created successfully.",
        user,
      });
    } catch (error) {
      console.error("Failed to create user:", error);

      if (error.code === "P2002") {
        return res.status(409).json({
          message: "This username is already in use.",
        });
      }

      return res.status(500).json({
        message: "Failed to create user.",
      });
    }
  }
);


/* UPDATE USER */
app.put(
  "/api/User/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const userId = Number(req.params.id);

      if (!Number.isInteger(userId) || userId < 1) {
        return res.status(400).json({
          message: "Invalid user ID.",
        });
      }

      const existingUser = await prisma.user.findUnique({
        where: { UserId: userId },
      });

      if (!existingUser) {
        return res.status(404).json({
          message: "User not found.",
        });
      }

      const Name = req.body?.Name ?? req.body?.name;
const UserName = req.body?.UserName ?? req.body?.userName;
const Email = req.body?.Email ?? req.body?.email;
const Password = req.body?.Password ?? req.body?.password;
const RoleId = req.body?.RoleId ?? req.body?.roleId;
const Status = req.body?.Status ?? req.body?.status;

      if (
        typeof Name !== "string" ||
        !Name.trim() ||
        typeof UserName !== "string" ||
        !UserName.trim() ||
        RoleId == null
      ) {
        return res.status(400).json({
          message: "Name, username and role are required.",
        });
      }

      const roleId = Number(RoleId);

      if (!Number.isInteger(roleId) || roleId < 1) {
        return res.status(400).json({
          message: "Please select a valid role.",
        });
      }

      const role = await prisma.role.findUnique({
        where: { RoleId: roleId },
      });

      if (!role) {
        return res.status(400).json({
          message: "Selected role does not exist.",
        });
      }

      const duplicateUser = await prisma.user.findFirst({
        where: {
          UserName: UserName.trim(),
          NOT: { UserId: userId },
        },
      });

      if (duplicateUser) {
        return res.status(409).json({
          message: "This username is already in use.",
        });
      }

      const data = {
        Name: Name.trim(),
        UserName: UserName.trim(),
        Email:
          typeof Email === "string" && Email.trim()
            ? Email.trim().toLowerCase()
            : null,
        RoleId: roleId,
      };

      if (Status !== undefined) {
        data.Status = Boolean(Status);
      }

      if (typeof Password === "string" && Password.length > 0) {
        if (Password.length < 6) {
          return res.status(400).json({
            message: "Password must be at least 6 characters.",
          });
        }

        data.Password = hashAspNetPassword(Password);
      }

      const user = await prisma.user.update({
        where: { UserId: userId },
        data,
        select: {
          UserId: true,
          Name: true,
          UserName: true,
          Email: true,
          RoleId: true,
          Status: true,
        },
      });

      return res.json({
        message: "User updated successfully.",
        user,
      });
    } catch (error) {
      console.error("Failed to update user:", error);

      if (error.code === "P2002") {
        return res.status(409).json({
          message: "This username is already in use.",
        });
      }

      return res.status(500).json({
        message: "Failed to update user.",
      });
    }
  }
);


/* DELETE USER */
app.delete(
  "/api/User/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const userId = Number(req.params.id);

      if (!Number.isInteger(userId) || userId < 1) {
        return res.status(400).json({
          message: "Invalid user ID.",
        });
      }

      if (Number(req.user.userId) === userId) {
        return res.status(400).json({
          message: "You cannot delete your own account while logged in.",
        });
      }

      const existingUser = await prisma.user.findUnique({
        where: { UserId: userId },
      });

      if (!existingUser) {
        return res.status(404).json({
          message: "User not found.",
        });
      }

      await prisma.user.delete({
        where: { UserId: userId },
      });

      return res.json({
        message: "User deleted successfully.",
      });
    } catch (error) {
      console.error("Failed to delete user:", error);

      if (error.code === "P2003" || error.code === "P2014") {
        return res.status(409).json({
          message:
            "This user cannot be deleted because related records exist. Deactivate the account instead.",
        });
      }

      return res.status(500).json({
        message: "Failed to delete user.",
      });
    }
  }
);


function verifyAspNetPassword(password, storedHash) {
  try {
    const hash = Buffer.from(storedHash, "base64");

    if (hash.length === 0) return false;

    // ASP.NET Core Identity V3 password format
    if (hash[0] === 0x01) {
      if (hash.length < 13) return false;

      const prf = hash.readUInt32BE(1);
      const iterations = hash.readUInt32BE(5);
      const saltLength = hash.readUInt32BE(9);

      if (
        ![0, 1, 2].includes(prf) ||
        iterations < 1 ||
        saltLength < 16 ||
        13 + saltLength >= hash.length
      ) {
        return false;
      }

      const salt = hash.subarray(13, 13 + saltLength);
      const expected = hash.subarray(13 + saltLength);

      const digest =
        prf === 2 ? "sha512" :
        prf === 1 ? "sha256" : "sha1";

      const actual = crypto.pbkdf2Sync(
        password,
        salt,
        iterations,
        expected.length,
        digest
      );

      return (
        actual.length === expected.length &&
        crypto.timingSafeEqual(actual, expected)
      );
    }

    // Older ASP.NET Identity V2 format
    if (hash[0] === 0x00 && hash.length === 49) {
      const salt = hash.subarray(1, 17);
      const expected = hash.subarray(17);

      const actual = crypto.pbkdf2Sync(
        password,
        salt,
        1000,
        32,
        "sha1"
      );

      return crypto.timingSafeEqual(actual, expected);
    }

    return false;
  } catch {
    return false;
  }
}


app.get("/api/test-route", (req, res) => {
  res.json({ message: "Test route works" });
});

app.post("/api/User/login", async (req, res) => {
  console.log("LOGIN REQUEST RECEIVED");
  try {
    const { UserName, Password } = req.body || {};

    if (
      typeof UserName !== "string" ||
      !UserName.trim() ||
      typeof Password !== "string" ||
      !Password
    ) {
      return res.status(400).json({
        message: "Username and password are required.",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        UserName: UserName.trim(),
      },
      include: {
        Role: true,
      },
    });

    if (!user) {
      return res.status(401).json({
        message: "Invalid username or password.",
      });
    }

    if (!user.Status) {
      return res.status(401).json({
        message: "User account is inactive.",
      });
    }

    const passwordValid = verifyAspNetPassword(
      Password,
      user.Password
    );

    if (!passwordValid) {
      return res.status(401).json({
        message: "Invalid username or password.",
      });
    }

    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET is not configured.");

      return res.status(500).json({
        message: "Login service is not configured.",
      });
    }

    const token = jwt.sign(
      {
        userId: user.UserId,
        roleId: user.RoleId,
        userName: user.UserName,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "8h",
      }
    );

    return res.json({
      message: "Login successful.",
      token,
      userId: user.UserId,
      name: user.Name,
      userName: user.UserName,
      roleId: user.RoleId,
      roleName: user.Role.RoleName,
    });
  } catch (error) {
    console.error("Login failed:", error.message);

    return res.status(500).json({
      message: "Login failed.",
    });
  }
});


app.get(
  "/api/StockTransaction",
  authenticateToken,
  async (req, res) => {
  try {
    const transactions = await prisma.stockTransaction.findMany({
      include: {
        MedicineBatch: {
          include: {
            Medicine: true,
            Supplier: true,
          },
        },
        User: {
          select: {
            UserId: true,
            Name: true,
            UserName: true,
          },
        },
      },
      orderBy: {
        TransactionId: "desc",
      },
    });

    res.json(transactions);
  } catch (error) {
    console.error("Failed to load stock transactions:", error.message);

    res.status(500).json({
      message: "Failed to load stock transactions",
    });
  }
});

app.get("/api/SupportRequests", authenticateToken, requireSalesAndSupportAccess, async (req, res) => {
  try {
    const requests = await prisma.supportRequests.findMany({
      include: {
        User: {
          select: {
            UserId: true,
            Name: true,
            UserName: true,
          },
        },
      },
      orderBy: {
        RequestId: "desc",
      },
    });

    res.json(requests);
  } catch (error) {
    console.error("Failed to load support requests:", error.message);

    res.status(500).json({
      message: "Failed to load support requests",
    });
  }
});

app.post("/api/SupportRequests", authenticateToken, requireSalesAndSupportAccess, async (req, res) => {
  try {
    const userId = parsePositiveId(req.user.userId, "authenticated user ID");
    const body = req.body || {};
    const data = validateSupportRequest({
      RequestType: body.RequestType,
      Message: body.Message,
      Status: "Open",
    });
    const request = await prisma.supportRequests.create({
      data: {
        ...data,
        UserId: userId,
        CreatedAt: new Date(),
        ResolvedAt: null,
      },
      include: {
        User: { select: { UserId: true, Name: true, UserName: true } },
      },
    });

    res.status(201).json(request);
  } catch (error) {
    console.error("Failed to create support request:", error.message);
    res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : "Failed to create support request",
    });
  }
});

app.put("/api/SupportRequests/:id", authenticateToken, requireSalesAndSupportAccess, async (req, res) => {
  try {
    const requestId = parsePositiveId(req.params.id, "request ID");
    const data = validateSupportRequest(req.body || {});
    const existing = await prisma.supportRequests.findUnique({ where: { RequestId: requestId } });
    if (!existing) throw routeError("Support request not found.", 404);

    const request = await prisma.supportRequests.update({
      where: { RequestId: requestId },
      data,
      include: {
        User: { select: { UserId: true, Name: true, UserName: true } },
      },
    });

    res.json(request);
  } catch (error) {
    console.error("Failed to replace support request:", error.message);
    res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : "Failed to replace support request",
    });
  }
});

app.patch("/api/SupportRequests/:id", authenticateToken, requireSalesAndSupportAccess, async (req, res) => {
  try {
    const requestId = parsePositiveId(req.params.id, "request ID");
    const data = validateSupportRequest(req.body || {}, true);
    if (Object.keys(data).length === 0) {
      throw routeError("Provide RequestType, Message, Status, or ResolvedAt to update.");
    }

    const existing = await prisma.supportRequests.findUnique({ where: { RequestId: requestId } });
    if (!existing) throw routeError("Support request not found.", 404);

    if (Object.hasOwn(data, "Status") && data.Status === "Resolved") {
      data.ResolvedAt = existing.ResolvedAt ?? new Date();
    } else if (Object.hasOwn(data, "Status") && existing.Status === "Resolved") {
      data.ResolvedAt = null;
    } else {
      data.ResolvedAt = existing.ResolvedAt;
    }

    const request = await prisma.supportRequests.update({
      where: { RequestId: requestId },
      data,
      include: {
        User: { select: { UserId: true, Name: true, UserName: true } },
      },
    });

    res.json(request);
  } catch (error) {
    console.error("Failed to update support request:", error.message);
    res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : "Failed to update support request",
    });
  }
});

app.delete("/api/SupportRequests/:id", authenticateToken, requireSalesAndSupportAccess, async (req, res) => {
  try {
    const requestId = parsePositiveId(req.params.id, "request ID");
    const existing = await prisma.supportRequests.findUnique({ where: { RequestId: requestId } });
    if (!existing) throw routeError("Support request not found.", 404);

    await prisma.supportRequests.delete({ where: { RequestId: requestId } });
    res.status(204).end();
  } catch (error) {
    console.error("Failed to delete support request:", error.message);
    res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : "Failed to delete support request",
    });
  }
});


app.get("/api/SaleItem", authenticateToken, async (req, res) => {
  try {
    const saleItems = await prisma.saleItem.findMany({
      include: {
        MedicineBatch: true,
      },
      orderBy: {
        SaleItemId: "desc",
      },
    });

    return res.json(saleItems);
  } catch (error) {
    console.error("Failed to load sale items:", error);

    return res.status(500).json({
      message: "Failed to load sale items",
    });
  }
});
// GET: Load all support requests
app.get("/api/SupportRequest", authenticateToken, async (req, res) => {
  try {
    const requests = await prisma.supportRequests.findMany({
      orderBy: {
        RequestId: "desc",
      },
    });

    res.json(requests);
  } catch (error) {
    console.error("Error loading support requests:", error);

    res.status(500).json({
      message: "Failed to load support requests",
      error: error.message,
    });
  }
});


/* UPDATE SUPPORT REQUEST STATUS */
app.put(
  "/api/SupportRequest/:id/status",
  authenticateToken,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          message: "Invalid support request ID.",
        });
      }

      const status =
        typeof req.body === "string"
          ? req.body
          : req.body?.status ?? req.body?.Status;

      const allowedStatuses = [
        "Pending",
        "In Progress",
        "Resolved",
      ];

      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          message: "Invalid status.",
        });
      }

      const request = await prisma.supportRequests.findUnique({
        where: { RequestId: id },
      });

      if (!request) {
        return res.status(404).json({
          message: "Support request not found.",
        });
      }

      const updatedRequest = await prisma.supportRequests.update({
        where: { RequestId: id },
        data: {
          Status: status,
          ResolvedAt:
            status === "Resolved" ? new Date() : null,
        },
      });

      return res.json(updatedRequest);
    } catch (error) {
      console.error("Error updating support request:", error);

      return res.status(500).json({
        message: "Failed to update support request status.",
      });
    }
  }
);


app.post("/api/SupportRequest", async (req, res) => {
  try {
    const { userId, requestType, message } = req.body;

    if (!userId || !requestType || !message?.trim()) {
      return res.status(400).json({
        message: "User ID, request type and message are required.",
      });
    }

    const request = await prisma.supportRequests.create({
      data: {
        UserId: Number(userId),
        RequestType: requestType,
        Message: message.trim(),
        Status: "Pending",
        CreatedAt: new Date(),
      },
    });

    return res.status(201).json({
      message: "Support request submitted successfully.",
      request,
    });
  } catch (error) {
    console.error("Support request error:", error);

    return res.status(500).json({
      message: "Failed to submit support request.",
    });
  }
});


/* DELETE SUPPORT REQUEST */
app.delete(
  "/api/SupportRequest/:id",
  authenticateToken,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          message: "Invalid support request ID.",
        });
      }

      const request = await prisma.supportRequests.findUnique({
        where: { RequestId: id },
      });

      if (!request) {
        return res.status(404).json({
          message: "Support request not found.",
        });
      }

      await prisma.supportRequests.delete({
        where: { RequestId: id },
      });

      return res.json({
        message: "Support request deleted successfully.",
      });
    } catch (error) {
      console.error("Error deleting support request:", error);

      return res.status(500).json({
        message: "Failed to delete support request.",
      });
    }
  }
);


function createAspNetPasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const iterations = 100000;
  const subkey = crypto.pbkdf2Sync(
    password,
    salt,
    iterations,
    32,
    "sha512"
  );

  const header = Buffer.alloc(13);
  header[0] = 0x01;
  header.writeUInt32BE(2, 1); // SHA512
  header.writeUInt32BE(iterations, 5);
  header.writeUInt32BE(salt.length, 9);

  return Buffer.concat([header, salt, subkey]).toString("base64");
}

const resetMailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

app.post("/api/PasswordReset/forgot", async (req, res) => {
  try {
    const email =
      typeof req.body?.email === "string"
        ? req.body.email.trim()
        : "";

    if (!email) {
      return res.status(400).json({
        message: "Email address eka enter karanna.",
      });
    }

    const genericMessage =
      "Email eka account ekakata sambandha nam reset link ekak yawanu atha.";

    const user = await prisma.user.findFirst({
      where: {
        Email: {
          equals: email,
          mode: "insensitive",
        },
        Status: true,
      },
    });

    if (!user) {
      return res.json({ message: genericMessage });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

    await prisma.passwordResetToken.updateMany({
      where: {
        UserId: user.UserId,
        UsedAt: null,
      },
      data: {
        UsedAt: now,
      },
    });

    await prisma.passwordResetToken.create({
      data: {
        UserId: user.UserId,
        TokenHash: tokenHash,
        CreatedAt: now,
        ExpiresAt: expiresAt,
      },
    });

    const frontendUrl = (
      process.env.FRONTEND_URL || "http://localhost:5173"
    ).replace(/\/+$/, "");

    const resetLink =
      `${frontendUrl}/reset-password?token=${rawToken}`;

    try {
      await resetMailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: user.Email,
        subject: "PharmaTrack Password Reset",
        text:
          `Password eka reset karanna me link eka open karanna:\n\n` +
          `${resetLink}\n\n` +
          `Me link eka minutes 15kin expire wenawa. Oya request kale nathnam me email eka ignore karanna.`,
      });
    } catch (mailError) {
      console.error("Password reset email failed:", mailError.message);

      await prisma.passwordResetToken.updateMany({
        where: {
          TokenHash: tokenHash,
          UsedAt: null,
        },
        data: {
          UsedAt: new Date(),
        },
      });

      return res.status(500).json({
        message: "Reset email eka yawanna bari una. SMTP settings check karanna.",
      });
    }

    return res.json({ message: genericMessage });
  } catch (error) {
    console.error("Forgot password failed:", error.message);

    return res.status(500).json({
      message: "Password reset request eka process karanna bari una.",
    });
  }
});

app.post("/api/PasswordReset/reset", async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};

    if (
      typeof token !== "string" ||
      !/^[a-f0-9]{64}$/i.test(token) ||
      typeof newPassword !== "string" ||
      newPassword.length < 8 ||
      newPassword.length > 128
    ) {
      return res.status(400).json({
        message: "Valid reset token ekak saha 8-128 characters password ekak denna.",
      });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const now = new Date();

    const resetRecord = await prisma.passwordResetToken.findFirst({
      where: {
        TokenHash: tokenHash,
        UsedAt: null,
        ExpiresAt: { gt: now },
        User: { Status: true },
      },
    });

    if (!resetRecord) {
      return res.status(400).json({
        message: "Reset link eka invalid, used, nathnam expire wela.",
      });
    }

    const passwordHash = createAspNetPasswordHash(newPassword);

    await prisma.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: {
          PasswordResetTokenId: resetRecord.PasswordResetTokenId,
          UsedAt: null,
          ExpiresAt: { gt: new Date() },
        },
        data: { UsedAt: new Date() },
      });

      if (consumed.count !== 1) {
        throw new Error("RESET_TOKEN_ALREADY_USED");
      }

      await tx.user.update({
        where: { UserId: resetRecord.UserId },
        data: { Password: passwordHash },
      });
    });

    return res.json({
      message: "Password reset una. Dan aluth password eken login wenna.",
    });
  } catch (error) {
    if (error.message === "RESET_TOKEN_ALREADY_USED") {
      return res.status(400).json({
        message: "Reset link eka use karala ho expire wela.",
      });
    }

    console.error("Reset password failed:", error.message);

    return res.status(500).json({
      message: "Password reset karanna bari una.",
    });
  }
});


const server = app.listen(PORT, () => {
  console.log(`PharmaTrack Node API running at http://localhost:${PORT}`);
});

server.on("close", () => {
  console.log("HTTP server has closed.");
});

server.on("error", (error) => {
  console.error("HTTP server error:", error);
});