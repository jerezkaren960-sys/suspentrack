require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'suspentrack_secret_key_2026';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Pool de conexiones
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'suspentrack',
    waitForConnections: true,
    connectionLimit: 10
});

// ==================== MIDDLEWARE ====================
const verificarToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Token no proporcionado' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.usuario = decoded;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Token inválido' });
    }
};

const verificarRol = (rolesPermitidos) => (req, res, next) => {
    if (!rolesPermitidos.includes(req.usuario.rol)) {
        return res.status(403).json({ error: 'Acceso denegado' });
    }
    next();
};

// ==================== ALGORITMO DE PRIORIZACIÓN ====================
async function calcularCriticidad(vehiculoId, connection) {
    const [vehiculo] = await connection.query(
        'SELECT kilometraje, frecuencia_uso, ultimo_mantenimiento FROM vehiculos WHERE id = ?',
        [vehiculoId]
    );

    let diasSinMantenimiento = 180;
    if (vehiculo[0].ultimo_mantenimiento) {
        const ultimo = new Date(vehiculo[0].ultimo_mantenimiento);
        const ahora = new Date();
        diasSinMantenimiento = Math.floor((ahora - ultimo) / (1000 * 60 * 60 * 24));
    }

    const [fallas] = await connection.query(
        'SELECT COUNT(*) as total FROM componentes WHERE vehiculo_id = ? AND estado IN ("MALO", "CRITICO")',
        [vehiculoId]
    );

    const [componentes] = await connection.query(
        'SELECT estado FROM componentes WHERE vehiculo_id = ?',
        [vehiculoId]
    );

    let puntajeComponentes = 0;
    const pesos = { EXCELENTE: 0, BUENO: 1, REGULAR: 2, MALO: 3, CRITICO: 4 };
    componentes.forEach(c => { puntajeComponentes += pesos[c.estado] || 0; });
    puntajeComponentes = componentes.length ? (puntajeComponentes / componentes.length) * 25 : 0;

    const kmPuntaje = Math.min((vehiculo[0].kilometraje / 200000) * 25, 25);
    const tiempoPuntaje = Math.min((diasSinMantenimiento / 365) * 25, 25);
    const fallasPuntaje = Math.min(fallas[0].total * 5, 25);
    const usoPuntaje = { BAJA: 5, MEDIA: 15, ALTA: 25 }[vehiculo[0].frecuencia_uso] || 10;

    const puntajeTotal = Math.round(kmPuntaje + tiempoPuntaje + fallasPuntaje + puntajeComponentes + usoPuntaje);

    let clasificacion;
    if (puntajeTotal >= 80) clasificacion = 'CRITICO';
    else if (puntajeTotal >= 60) clasificacion = 'ALTO';
    else if (puntajeTotal >= 40) clasificacion = 'MEDIO';
    else clasificacion = 'BAJO';

    await connection.query(
        `INSERT INTO priorizaciones (vehiculo_id, kilometraje_puntos, mantenimiento_puntos, fallas_puntos, componentes_puntos, uso_puntos, puntaje_total, clasificacion) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [vehiculoId, kmPuntaje, tiempoPuntaje, fallasPuntaje, puntajeComponentes, usoPuntaje, puntajeTotal, clasificacion]
    );

    await connection.query('UPDATE vehiculos SET criticidad = ? WHERE id = ?', [clasificacion, vehiculoId]);

    if (clasificacion === 'CRITICO') {
        await connection.query(
            `INSERT INTO alertas (vehiculo_id, nivel, mensaje) VALUES (?, ?, ?)`,
            [vehiculoId, 'CRITICO', `Vehículo requiere mantenimiento urgente. Puntaje: ${puntajeTotal}`]
        );
    }

    return { puntajeTotal, clasificacion };
}

app.post('/api/login', async (req, res) => {
    // SIMULADOR: acepta cualquier credencial
    const { correo, password } = req.body;

    const token = jwt.sign(
        { id: 1, nombre: 'Usuario', rol: 'ADMIN' },
        JWT_SECRET,
        { expiresIn: '8h' }
    );

    res.json({
        token,
        usuario: { id: 1, nombre: 'Usuario Simulador', rol: 'ADMIN' }
    });
});

// ==================== USUARIOS ====================
app.get('/api/users', verificarToken, verificarRol(['ADMIN']), async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, nombre, correo, rol, estado FROM usuarios');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users', verificarToken, verificarRol(['ADMIN']), async (req, res) => {
    try {
        const { nombre, correo, password, rol } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await pool.query('INSERT INTO usuarios (nombre, correo, password, rol, estado) VALUES (?, ?, ?, ?, "ACTIVO")', [nombre, correo, hashedPassword, rol]);
        res.json({ id: result.insertId, mensaje: 'Usuario creado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/users/:id', verificarToken, verificarRol(['ADMIN']), async (req, res) => {
    try {
        const { nombre, correo, rol, estado } = req.body;
        await pool.query('UPDATE usuarios SET nombre = ?, correo = ?, rol = ?, estado = ? WHERE id = ?', [nombre, correo, rol, estado, req.params.id]);
        res.json({ mensaje: 'Usuario actualizado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/users/:id', verificarToken, verificarRol(['ADMIN']), async (req, res) => {
    try {
        await pool.query('DELETE FROM usuarios WHERE id = ?', [req.params.id]);
        res.json({ mensaje: 'Usuario eliminado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== VEHÍCULOS ====================
app.get('/api/vehicles', verificarToken, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM vehiculos ORDER BY id DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/vehicles', verificarToken, verificarRol(['ADMIN', 'TECNICO']), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { placa, marca, modelo, anio, kilometraje, capacidad_carga, frecuencia_uso, estado_general } = req.body;
        const [result] = await connection.query(
            `INSERT INTO vehiculos (placa, marca, modelo, anio, kilometraje, capacidad_carga, frecuencia_uso, estado_general)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [placa, marca, modelo, anio, kilometraje, capacidad_carga, frecuencia_uso || 'MEDIA', estado_general || 'OPERATIVO']
        );

        const componentes = ['AMORTIGUADOR', 'RESORTE', 'ROTULA', 'BUJE', 'BRAZO_SUSPENSION', 'BARRA_ESTABILIZADORA'];
        for (const comp of componentes) {
            await connection.query('INSERT INTO componentes (vehiculo_id, nombre, estado, fecha_inspeccion) VALUES (?, ?, "BUENO", CURDATE())', [result.insertId, comp]);
        }

        await connection.commit();
        res.json({ id: result.insertId, mensaje: 'Vehículo registrado' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
});

app.put('/api/vehicles/:id', verificarToken, verificarRol(['ADMIN', 'TECNICO']), async (req, res) => {
    try {
        const { placa, marca, modelo, anio, kilometraje, capacidad_carga, estado_general } = req.body;
        await pool.query('UPDATE vehiculos SET placa=?, marca=?, modelo=?, anio=?, kilometraje=?, capacidad_carga=?, estado_general=? WHERE id=?',
            [placa, marca, modelo, anio, kilometraje, capacidad_carga, estado_general, req.params.id]);
        res.json({ mensaje: 'Vehículo actualizado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/vehicles/:id', verificarToken, verificarRol(['ADMIN']), async (req, res) => {
    try {
        await pool.query('DELETE FROM vehiculos WHERE id = ?', [req.params.id]);
        res.json({ mensaje: 'Vehículo eliminado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/vehicles/:id/recalculate', verificarToken, async (req, res) => {
    try {
        const resultado = await calcularCriticidad(req.params.id, pool);
        res.json({ mensaje: 'Criticidad recalculada', ...resultado });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== COMPONENTES ====================
app.get('/api/components', verificarToken, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT c.*, v.placa FROM componentes c JOIN vehiculos v ON c.vehiculo_id = v.id');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/components', verificarToken, verificarRol(['ADMIN', 'TECNICO']), async (req, res) => {
    try {
        const { vehiculo_id, nombre, estado, observaciones } = req.body;
        const [result] = await pool.query('INSERT INTO componentes (vehiculo_id, nombre, estado, fecha_inspeccion, observaciones) VALUES (?, ?, ?, CURDATE(), ?)',
            [vehiculo_id, nombre, estado, observaciones]);
        await calcularCriticidad(vehiculo_id, pool);
        res.json({ id: result.insertId, mensaje: 'Componente registrado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== MANTENIMIENTOS ====================
app.get('/api/maintenances', verificarToken, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT m.*, v.placa FROM mantenimientos m JOIN vehiculos v ON m.vehiculo_id = v.id ORDER BY m.fecha DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/maintenances', verificarToken, verificarRol(['ADMIN', 'TECNICO']), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { vehiculo_id, tecnico_id, tipo, fecha, costo, kilometraje, descripcion } = req.body;
        const [result] = await connection.query('INSERT INTO mantenimientos (vehiculo_id, tecnico_id, tipo, fecha, costo, descripcion) VALUES (?, ?, ?, ?, ?, ?)',
            [vehiculo_id, tecnico_id, tipo, fecha, costo, descripcion]);
        await connection.query('UPDATE vehiculos SET kilometraje = ?, ultimo_mantenimiento = ? WHERE id = ?', [kilometraje, fecha, vehiculo_id]);
        await connection.commit();
        await calcularCriticidad(vehiculo_id, pool);
        res.json({ id: result.insertId, mensaje: 'Mantenimiento registrado' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
});

// ==================== INSPECCIONES ====================
app.get('/api/inspections', verificarToken, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT i.*, v.placa, u.nombre as tecnico_nombre FROM inspecciones i JOIN vehiculos v ON i.vehiculo_id = v.id JOIN usuarios u ON i.tecnico_id = u.id ORDER BY i.fecha DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/inspections', verificarToken, verificarRol(['ADMIN', 'TECNICO']), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { vehiculo_id, tecnico_id, fecha, kilometraje, observaciones } = req.body;
        const [result] = await connection.query('INSERT INTO inspecciones (vehiculo_id, tecnico_id, fecha, observaciones) VALUES (?, ?, ?, ?)',
            [vehiculo_id, tecnico_id, fecha, observaciones]);
        await connection.query('UPDATE vehiculos SET kilometraje = ? WHERE id = ?', [kilometraje, vehiculo_id]);
        await connection.commit();
        res.json({ id: result.insertId, mensaje: 'Inspección registrada' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
});

// ==================== ALERTAS ====================
app.get('/api/alerts', verificarToken, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT a.*, v.placa FROM alertas a JOIN vehiculos v ON a.vehiculo_id = v.id ORDER BY a.fecha DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== DASHBOARD ====================
app.get('/api/dashboard', verificarToken, async (req, res) => {
    try {
        const [[vehiculos]] = await pool.query('SELECT COUNT(*) as total FROM vehiculos');
        const [[operativos]] = await pool.query('SELECT COUNT(*) as total FROM vehiculos WHERE estado_general = "OPERATIVO"');
        const [[criticos]] = await pool.query('SELECT COUNT(*) as total FROM vehiculos WHERE criticidad = "CRITICO"');
        const [[costos]] = await pool.query('SELECT IFNULL(SUM(costo), 0) as total FROM mantenimientos');
        const [[mantenimientosRealizados]] = await pool.query('SELECT COUNT(*) as total FROM mantenimientos');
        const [[mantenimientosPendientes]] = await pool.query('SELECT COUNT(*) as total FROM alertas WHERE nivel = "CRITICO"');
        const [componentesDesgaste] = await pool.query('SELECT nombre, COUNT(*) as cantidad FROM componentes WHERE estado IN ("MALO", "CRITICO") GROUP BY nombre ORDER BY cantidad DESC LIMIT 5');
        const [alertasRecientes] = await pool.query('SELECT a.*, v.placa FROM alertas a JOIN vehiculos v ON a.vehiculo_id = v.id ORDER BY a.fecha DESC LIMIT 5');

        res.json({
            total_vehiculos: vehiculos.total,
            vehiculos_operativos: operativos.total,
            vehiculos_criticos: criticos.total,
            costos_acumulados: costos.total,
            mantenimientos_realizados: mantenimientosRealizados.total,
            mantenimientos_pendientes: mantenimientosPendientes.total,
            componentes_desgaste: componentesDesgaste,
            alertas_recientes: alertasRecientes
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== REPORTES ====================
app.get('/api/reports/generate', verificarToken, async (req, res) => {
    try {
        const { tipo, formato } = req.query;

        if (formato === 'pdf') {
            const doc = new PDFDocument();
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=reporte_${tipo}.pdf`);
            doc.pipe(res);
            doc.fontSize(20).text('SuspenTrack - Reporte', { align: 'center' });
            doc.moveDown();
            doc.fontSize(12).text(`Tipo: ${tipo}`);
            doc.text(`Fecha: ${new Date().toLocaleDateString()}`);
            doc.end();
        } else {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Reporte');
            worksheet.columns = [{ header: 'Dato', key: 'dato' }, { header: 'Valor', key: 'valor' }];
            worksheet.addRow({ dato: 'Tipo de reporte', valor: tipo });
            worksheet.addRow({ dato: 'Fecha generación', valor: new Date().toLocaleDateString() });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=reporte_${tipo}.xlsx`);
            await workbook.xlsx.write(res);
            res.end();
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== INICIO ====================
app.listen(PORT, () => {
    console.log(`🚀 SuspenTrack corriendo en http://localhost:${PORT}`);
});

// Redirección a login
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});