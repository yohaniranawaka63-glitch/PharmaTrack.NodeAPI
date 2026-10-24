
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { PrismaClient, Prisma } = require("@prisma/client");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

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

app.get("/api/MedicineBatch", authenticateToken, async (req, res) => {

  try {
    const batches = await prisma.medicineBatch.findMany({
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



app.get("/api/Supplier", authenticateToken, async (req, res) => {

  try {
    const suppliers = await prisma.supplier.findMany({
      orderBy: {
        SupplierName: "asc",
      },
    });

    res.json(suppliers);
  } catch (error) {
    console.error("Failed to load suppliers:", error.message);

    res.status(500).json({
      message: "Failed to load suppliers",
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

app.listen(PORT, () => {
  console.log(`PharmaTrack Node API running at http://localhost:${PORT}`);
});
