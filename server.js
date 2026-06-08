// ============================================
// SUSPENTRACK - SERVIDOR SIN LOGIN
// ============================================

require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// SIMULADOR - USUARIO SIEMPRE LOGUEADO
// ============================================
app.use((req, res, next) => {
    req.usuario = { id: 1, nombre: 'Administrador', rol: 'ADMIN' };
    next();
});

// ============================================
// REDIRIGIR RAÍZ AL DASHBOARD
// ============================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ============================================
// CONEXIÓN A BASE DE DATOS
// ============================================
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'suspentrack',
    waitForConnections: true,
    connectionLimit: 10
});

app.locals.pool = pool;

// ============================================
// CREAR TABLAS AUTOMÁTICAMENTE
// ============================================
async function crearTablas() {
    const connection = await pool.getConnection();
    try {
        await connection.query(`
            CREATE TABLE IF NOT EXISTS usuarios(
                                                   id INT AUTO_INCREMENT PRIMARY KEY,
                                                   nombre VARCHAR(100) NOT NULL,
                correo VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                rol ENUM('ADMIN','TECNICO','OPERADOR') NOT NULL,
                estado ENUM('ACTIVO','INACTIVO') DEFAULT 'ACTIVO',
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS vehiculos(
                                                    id INT AUTO_INCREMENT PRIMARY KEY,
                                                    placa VARCHAR(10) UNIQUE NOT NULL,
                marca VARCHAR(50) NOT NULL,
                modelo VARCHAR(50) NOT NULL,
                anio INT,
                kilometraje INT DEFAULT 0,
                capacidad_carga DECIMAL(10,2),
                frecuencia_uso ENUM('BAJA','MEDIA','ALTA') DEFAULT 'MEDIA',
                estado_general ENUM('OPERATIVO','MANTENIMIENTO','INOPERATIVO') DEFAULT 'OPERATIVO',
                criticidad VARCHAR(20) DEFAULT 'NO EVALUADO',
                ultimo_mantenimiento DATE,
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS componentes(
                                                      id INT AUTO_INCREMENT PRIMARY KEY,
                                                      vehiculo_id INT NOT NULL,
                                                      nombre ENUM('AMORTIGUADOR','RESORTE','ROTULA','BUJE','BRAZO_SUSPENSION','BARRA_ESTABILIZADORA') NOT NULL,
                estado ENUM('EXCELENTE','BUENO','REGULAR','MALO','CRITICO') DEFAULT 'BUENO',
                fecha_inspeccion DATE,
                observaciones TEXT
                )
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS inspecciones(
                                                       id INT AUTO_INCREMENT PRIMARY KEY,
                                                       vehiculo_id INT NOT NULL,
                                                       tecnico_id INT NOT NULL,
                                                       fecha DATE NOT NULL,
                                                       kilometraje INT DEFAULT 0,
                                                       observaciones TEXT,
                                                       evidencia VARCHAR(500)
                )
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS mantenimientos(
                                                         id INT AUTO_INCREMENT PRIMARY KEY,
                                                         vehiculo_id INT NOT NULL,
                                                         tecnico_id INT NOT NULL,
                                                         tipo ENUM('PREVENTIVO','CORRECTIVO') NOT NULL,
                fecha DATE NOT NULL,
                costo DECIMAL(10,2) DEFAULT 0,
                descripcion TEXT
                )
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS alertas(
                                                  id INT AUTO_INCREMENT PRIMARY KEY,
                                                  vehiculo_id INT NOT NULL,
                                                  nivel ENUM('BAJO','MEDIO','ALTO','CRITICO') NOT NULL,
                mensaje TEXT,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS priorizaciones(
                                                         id INT AUTO_INCREMENT PRIMARY KEY,
                                                         vehiculo_id INT NOT NULL,
                                                         kilometraje_puntos INT DEFAULT 0,
                                                         mantenimiento_puntos INT DEFAULT 0,
                                                         fallas_puntos INT DEFAULT 0,
                                                         componentes_puntos INT DEFAULT 0,
                                                         uso_puntos INT DEFAULT 0,
                                                         puntaje_total INT DEFAULT 0,
                                                         clasificacion ENUM('BAJO','MEDIO','ALTO','CRITICO'),
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
        `);

        await connection.query(`
            INSERT IGNORE INTO usuarios (nombre, correo, password, rol, estado) VALUES 
            ('Administrador', 'admin@suspentrack.com', '$2a$10$N9qo8uLOickgx2ZMRZoMy.MrJ5qTqC8q8q8q8q8q8q8q8q8q8q', 'ADMIN', 'ACTIVO')
        `);

        await connection.query(`
            INSERT IGNORE INTO vehiculos (placa, marca, modelo, anio, kilometraje, capacidad_carga, frecuencia_uso, estado_general) VALUES
            ('ABC-123', 'Chevrolet', 'NPR', 2020, 85000, 3500, 'ALTA', 'OPERATIVO'),
            ('DEF-456', 'Ford', 'Cargo', 2019, 120000, 4000, 'ALTA', 'MANTENIMIENTO'),
            ('GHI-789', 'Hino', '300', 2021, 45000, 3800, 'MEDIA', 'OPERATIVO')
        `);

        console.log('✅ Tablas creadas/verificadas correctamente');
    } catch (error) {
        console.error('❌ Error creando tablas:', error.message);
    } finally {
        connection.release();
    }
}

// Ejecutar creación de tablas
crearTablas();

// ============================================
// ALGORITMO DE PRIORIZACIÓN
// ============================================
async function calcularCriticidad(vehiculoId, connection) {
    const [vehiculo] = await connection.query(
        'SELECT kilometraje, frecuencia_uso, ultimo_mantenimiento FROM vehiculos WHERE id = ?',
        [vehiculoId]
    );

    if (vehiculo.length === 0) return null;

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
    const pesos = { 'EXCELENTE': 0, 'BUENO': 1, 'REGULAR': 2, 'MALO': 3, 'CRITICO': 4 };

    componentes.forEach(c => {
        puntajeComponentes += pesos[c.estado] || 0;
    });

    puntajeComponentes = componentes.length ? (puntajeComponentes / componentes.length) * 25 : 0;

    const kmPuntaje = Math.min((vehiculo[0].kilometraje / 200000) * 25, 25);
    const tiempoPuntaje = Math.min((diasSinMantenimiento / 365) * 25, 25);
    const fallasPuntaje = Math.min(fallas[0].total * 5, 25);
    const usoPuntaje = { 'BAJA': 5, 'MEDIA': 15, 'ALTA': 25 }[vehiculo[0].frecuencia_uso] || 10;

    const puntajeTotal = Math.round(kmPuntaje + tiempoPuntaje + fallasPuntaje + puntajeComponentes + usoPuntaje);

    let clasificacion;
    if (puntajeTotal >= 80) clasificacion = 'CRITICO';
    else if (puntajeTotal >= 60) clasificacion = 'ALTO';
    else if (puntajeTotal >= 40) clasificacion = 'MEDIO';
    else clasificacion = 'BAJO';

    await connection.query(
        `INSERT INTO priorizaciones
         (vehiculo_id, kilometraje_puntos, mantenimiento_puntos, fallas_puntos, componentes_puntos, uso_puntos, puntaje_total, clasificacion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [vehiculoId, kmPuntaje, tiempoPuntaje, fallasPuntaje, puntajeComponentes, usoPuntaje, puntajeTotal, clasificacion]
    );

    await connection.query('UPDATE vehiculos SET criticidad = ? WHERE id = ?', [clasificacion, vehiculoId]);

    if (clasificacion === 'CRITICO') {
        const [existe] = await connection.query(
            'SELECT id FROM alertas WHERE vehiculo_id = ? AND nivel = "CRITICO" AND fecha > DATE_SUB(NOW(), INTERVAL 1 DAY)',
            [vehiculoId]
        );

        if (existe.length === 0) {
            await connection.query(
                `INSERT INTO alertas (vehiculo_id, nivel, mensaje)
                 VALUES (?, ?, ?)`,
                [vehiculoId, 'CRITICO', `⚠️ ALERTA CRÍTICA: Vehículo requiere mantenimiento urgente. Puntaje total: ${puntajeTotal}/100`]
            );
        }
    }

    return { puntajeTotal, clasificacion };
}

// ============================================
// ENDPOINTS DE VEHÍCULOS
// ============================================
app.get('/api/vehicles', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM vehiculos ORDER BY id DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/vehicles/:id', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM vehiculos WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Vehículo no encontrado' });
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/vehicles', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { placa, marca, modelo, anio, kilometraje, capacidad_carga, frecuencia_uso, estado_general } = req.body;

        const [result] = await connection.query(
            `INSERT INTO vehiculos (placa, marca, modelo, anio, kilometraje, capacidad_carga, frecuencia_uso, estado_general)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [placa, marca, modelo, anio || null, kilometraje || 0, capacidad_carga || 0, frecuencia_uso || 'MEDIA', estado_general || 'OPERATIVO']
        );

        const componentes = ['AMORTIGUADOR', 'RESORTE', 'ROTULA', 'BUJE', 'BRAZO_SUSPENSION', 'BARRA_ESTABILIZADORA'];
        for (const comp of componentes) {
            await connection.query(
                'INSERT INTO componentes (vehiculo_id, nombre, estado, fecha_inspeccion) VALUES (?, ?, "BUENO", CURDATE())',
                [result.insertId, comp]
            );
        }

        await connection.commit();
        res.json({ id: result.insertId, mensaje: 'Vehículo registrado exitosamente' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
});

app.put('/api/vehicles/:id', async (req, res) => {
    try {
        const { placa, marca, modelo, anio, kilometraje, capacidad_carga, estado_general } = req.body;
        await pool.query(
            `UPDATE vehiculos SET placa=?, marca=?, modelo=?, anio=?, kilometraje=?, capacidad_carga=?, estado_general=? WHERE id=?`,
            [placa, marca, modelo, anio, kilometraje, capacidad_carga, estado_general, req.params.id]
        );
        res.json({ mensaje: 'Vehículo actualizado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/vehicles/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM vehiculos WHERE id = ?', [req.params.id]);
        res.json({ mensaje: 'Vehículo eliminado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/vehicles/:id/recalculate', async (req, res) => {
    try {
        const resultado = await calcularCriticidad(req.params.id, pool);
        if (!resultado) return res.status(404).json({ error: 'Vehículo no encontrado' });
        res.json({ mensaje: 'Criticidad recalculada', ...resultado });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ENDPOINTS DE COMPONENTES
// ============================================
app.get('/api/components', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT c.*, v.placa FROM componentes c JOIN vehiculos v ON c.vehiculo_id = v.id');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/components/:id', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM componentes WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Componente no encontrado' });
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/components', async (req, res) => {
    try {
        const { vehiculo_id, nombre, estado, observaciones } = req.body;
        const [result] = await pool.query(
            'INSERT INTO componentes (vehiculo_id, nombre, estado, fecha_inspeccion, observaciones) VALUES (?, ?, ?, CURDATE(), ?)',
            [vehiculo_id, nombre, estado, observaciones]
        );
        await calcularCriticidad(vehiculo_id, pool);
        res.json({ id: result.insertId, mensaje: 'Componente registrado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/components/:id', async (req, res) => {
    try {
        const { estado, observaciones } = req.body;
        const [componente] = await pool.query('SELECT vehiculo_id FROM componentes WHERE id = ?', [req.params.id]);
        await pool.query('UPDATE componentes SET estado = ?, observaciones = ?, fecha_inspeccion = CURDATE() WHERE id = ?', [estado, observaciones, req.params.id]);
        if (componente.length > 0) await calcularCriticidad(componente[0].vehiculo_id, pool);
        res.json({ mensaje: 'Componente actualizado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ENDPOINTS DE MANTENIMIENTOS
// ============================================
app.get('/api/maintenances', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT m.*, v.placa FROM mantenimientos m JOIN vehiculos v ON m.vehiculo_id = v.id ORDER BY m.fecha DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/maintenances', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { vehiculo_id, tecnico_id, tipo, fecha, costo, kilometraje, descripcion } = req.body;
        const [result] = await connection.query(
            'INSERT INTO mantenimientos (vehiculo_id, tecnico_id, tipo, fecha, costo, descripcion) VALUES (?, ?, ?, ?, ?, ?)',
            [vehiculo_id, tecnico_id, tipo, fecha, costo, descripcion]
        );
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

// ============================================
// ENDPOINTS DE INSPECCIONES
// ============================================
app.get('/api/inspections', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT i.*, v.placa FROM inspecciones i JOIN vehiculos v ON i.vehiculo_id = v.id ORDER BY i.fecha DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/inspections', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { vehiculo_id, tecnico_id, fecha, kilometraje, observaciones, componentes } = req.body;
        const [result] = await connection.query(
            'INSERT INTO inspecciones (vehiculo_id, tecnico_id, fecha, kilometraje, observaciones) VALUES (?, ?, ?, ?, ?)',
            [vehiculo_id, tecnico_id, fecha, kilometraje, observaciones]
        );

        if (componentes && componentes.length > 0) {
            for (const comp of componentes) {
                await connection.query(
                    'UPDATE componentes SET estado = ?, fecha_inspeccion = ?, observaciones = ? WHERE vehiculo_id = ? AND nombre = ?',
                    [comp.estado, fecha, comp.observaciones || null, vehiculo_id, comp.nombre]
                );
            }
        }

        await connection.commit();
        await calcularCriticidad(vehiculo_id, pool);
        res.json({ id: result.insertId, mensaje: 'Inspección registrada' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
});

// ============================================
// ENDPOINTS DE ALERTAS
// ============================================
app.get('/api/alerts', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT a.*, v.placa FROM alertas a JOIN vehiculos v ON a.vehiculo_id = v.id ORDER BY a.fecha DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/alerts/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM alertas WHERE id = ?', [req.params.id]);
        res.json({ mensaje: 'Alerta eliminada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ENDPOINTS DE USUARIOS
// ============================================
app.get('/api/users', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, nombre, correo, rol, estado FROM usuarios');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/users/:id', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, nombre, correo, rol, estado FROM usuarios WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users', async (req, res) => {
    try {
        const { nombre, correo, password, rol } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await pool.query('INSERT INTO usuarios (nombre, correo, password, rol, estado) VALUES (?, ?, ?, ?, "ACTIVO")', [nombre, correo, hashedPassword, rol]);
        res.json({ id: result.insertId, mensaje: 'Usuario creado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/users/:id', async (req, res) => {
    try {
        const { nombre, correo, rol, estado } = req.body;
        await pool.query('UPDATE usuarios SET nombre = ?, correo = ?, rol = ?, estado = ? WHERE id = ?', [nombre, correo, rol, estado, req.params.id]);
        res.json({ mensaje: 'Usuario actualizado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM usuarios WHERE id = ?', [req.params.id]);
        res.json({ mensaje: 'Usuario eliminado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ENDPOINTS DE DASHBOARD
// ============================================
app.get('/api/dashboard', async (req, res) => {
    try {
        const [[vehiculos]] = await pool.query('SELECT COUNT(*) as total FROM vehiculos');
        const [[operativos]] = await pool.query('SELECT COUNT(*) as total FROM vehiculos WHERE estado_general = "OPERATIVO"');
        const [[criticos]] = await pool.query('SELECT COUNT(*) as total FROM vehiculos WHERE criticidad = "CRITICO"');
        const [[costos]] = await pool.query('SELECT IFNULL(SUM(costo), 0) as total FROM mantenimientos WHERE YEAR(fecha) = YEAR(CURDATE())');
        const [[mantenimientosRealizados]] = await pool.query('SELECT COUNT(*) as total FROM mantenimientos WHERE YEAR(fecha) = YEAR(CURDATE())');
        const [[mantenimientosPendientes]] = await pool.query('SELECT COUNT(*) as total FROM alertas WHERE nivel = "CRITICO"');

        const [componentesDesgaste] = await pool.query(
            `SELECT nombre, COUNT(*) as cantidad FROM componentes WHERE estado IN ("MALO", "CRITICO") GROUP BY nombre ORDER BY cantidad DESC LIMIT 5`
        );

        const [alertasRecientes] = await pool.query(
            `SELECT a.*, v.placa FROM alertas a JOIN vehiculos v ON a.vehiculo_id = v.id ORDER BY a.fecha DESC LIMIT 10`
        );

        const [mantenimientosPorMes] = await pool.query(
            `SELECT DATE_FORMAT(fecha, '%Y-%m') as mes, COUNT(*) as cantidad FROM mantenimientos WHERE fecha >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH) GROUP BY DATE_FORMAT(fecha, '%Y-%m') ORDER BY mes ASC`
        );

        const [vehiculosPorCriticidad] = await pool.query(
            `SELECT criticidad, COUNT(*) as cantidad FROM vehiculos GROUP BY criticidad`
        );

        res.json({
            total_vehiculos: vehiculos.total,
            vehiculos_operativos: operativos.total,
            vehiculos_criticos: criticos.total,
            costos_acumulados: costos.total,
            mantenimientos_realizados: mantenimientosRealizados.total,
            mantenimientos_pendientes: mantenimientosPendientes.total,
            componentes_desgaste: componentesDesgaste,
            alertas_recientes: alertasRecientes,
            mantenimientos_por_mes: mantenimientosPorMes,
            vehiculos_por_criticidad: vehiculosPorCriticidad
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// REPORTES
// ============================================
app.get('/api/reports/generate', async (req, res) => {
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

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
    console.log(`🚀 SuspenTrack corriendo en http://localhost:${PORT}`);
});