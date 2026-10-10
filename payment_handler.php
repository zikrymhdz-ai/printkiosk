<?php
require_once __DIR__ . '/config.php';
jsonHeader();

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'POST' && isset($_GET['action'])) {
    $action = $_GET['action'];

    if ($action === 'confirm') {
        handlePaymentConfirm();
    } elseif ($action === 'simulate') {
        handlePaymentSimulate();
    } elseif ($action === 'check-status') {
        handleCheckStatus();
    } else {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid action']);
    }
} else {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
}

function handlePaymentConfirm() {
    $input = json_decode(file_get_contents('php://input'), true);
    $jobId = $input['job_id'] ?? '';
    $reference = $input['reference'] ?? 'PAY-' . strtoupper(bin2hex(random_bytes(8)));

    if (empty($jobId)) {
        http_response_code(400);
        echo json_encode(['error' => 'Job ID required']);
        return;
    }

    // Get print job
    $jobResult = supabaseRequest('GET', '/print_jobs', null, [
        'job_id' => 'eq.' . $jobId,
        'select' => '*'
    ]);

    if ($jobResult['error'] || empty($jobResult['data'])) {
        http_response_code(404);
        echo json_encode(['error' => 'Print job not found']);
        return;
    }

    $job = $jobResult['data'][0];

    if ($job['paid']) {
        echo json_encode(['success' => true, 'message' => 'Print job already paid', 'job' => $job]);
        return;
    }

    // Create payment record
    $paymentResult = supabaseRequest('POST', '/payments', [
        'print_job_id' => $job['id'],
        'user_id' => $job['user_id'],
        'amount' => $job['total_price'],
        'method' => 'tng_qr',
        'reference' => $reference,
        'status' => 'confirmed',
        'notified_at' => date('c')
    ]);

    if ($paymentResult['error']) {
        http_response_code(500);
        echo json_encode(['error' => 'Failed to create payment record']);
        return;
    }

    // Update job status to ready_to_print and mark paid
    $updateResult = supabaseRequest('PATCH', '/print_jobs?id=eq.' . $job['id'], [
        'status' => 'ready_to_print',
        'paid' => true,
        'payment_ref' => $reference,
        'updated_at' => date('c')
    ]);

    if ($updateResult['error']) {
        http_response_code(500);
        echo json_encode(['error' => 'Failed to update job status']);
        return;
    }

    // Award coins to user if user_id exists
    if ($job['user_id']) {
        $coinsEarned = floor($job['total_price']); // 1 coin per RM 1

        // Get current user coins
        $userResult = supabaseRequest('GET', '/users', null, [
            'id' => 'eq.' . $job['user_id'],
            'select' => 'coins'
        ]);

        if (!$userResult['error'] && !empty($userResult['data'])) {
            $currentCoins = $userResult['data'][0]['coins'];
            $newBalance = $currentCoins + $coinsEarned;

            supabaseRequest('PATCH', '/users?id=eq.' . $job['user_id'], [
                'coins' => $newBalance
            ]);

            supabaseRequest('POST', '/coin_transactions', [
                'user_id' => $job['user_id'],
                'print_job_id' => $job['id'],
                'type' => 'earned',
                'amount' => $coinsEarned,
                'description' => 'Print job ' . $job['job_id'],
                'balance_after' => $newBalance
            ]);
        }
    }

    // Create alert
    supabaseRequest('POST', '/alerts', [
        'type' => 'payment_received',
        'message' => 'Payment received for job ' . $job['job_id'] . ' - RM ' . number_format($job['total_price'], 2),
        'severity' => 'info',
        'is_read' => false
    ]);

    echo json_encode([
        'success' => true,
        'message' => 'Payment confirmed',
        'job_id' => $jobId,
        'reference' => $reference,
        'coins_earned' => $coinsEarned ?? 0
    ]);
}

function handlePaymentSimulate() {
    $input = json_decode(file_get_contents('php://input'), true);
    $jobId = $input['job_id'] ?? '';

    if (empty($jobId)) {
        http_response_code(400);
        echo json_encode(['error' => 'Job ID required']);
        return;
    }

    // Get print job
    $jobResult = supabaseRequest('GET', '/print_jobs', null, [
        'job_id' => 'eq.' . $jobId,
        'select' => '*'
    ]);

    if ($jobResult['error'] || empty($jobResult['data'])) {
        http_response_code(404);
        echo json_encode(['error' => 'Print job not found']);
        return;
    }

    $job = $jobResult['data'][0];

    if ($job['paid']) {
        echo json_encode(['success' => true, 'message' => 'Print job already paid', 'job' => $job]);
        return;
    }

    $reference = 'SIM-' . strtoupper(bin2hex(random_bytes(8)));

    // Update job status to ready_to_print and mark paid
    $updateResult = supabaseRequest('PATCH', '/print_jobs?id=eq.' . $job['id'], [
        'status' => 'ready_to_print',
        'paid' => true,
        'payment_ref' => $reference,
        'updated_at' => date('c')
    ]);

    if ($updateResult['error']) {
        http_response_code(500);
        echo json_encode(['error' => 'Failed to update job status']);
        return;
    }

    echo json_encode([
        'success' => true,
        'message' => 'Payment simulated - job marked as paid',
        'job_id' => $jobId,
        'reference' => $reference
    ]);
}

function handleCheckStatus() {
    $input = json_decode(file_get_contents('php://input'), true);
    $jobId = $input['job_id'] ?? ($_GET['job_id'] ?? '');

    if (empty($jobId)) {
        http_response_code(400);
        echo json_encode(['error' => 'Job ID required']);
        return;
    }

    $result = supabaseRequest('GET', '/print_jobs', null, [
        'job_id' => 'eq.' . $jobId,
        'select' => 'status,paid,payment_ref,total_price'
    ]);

    if ($result['error'] || empty($result['data'])) {
        http_response_code(404);
        echo json_encode(['error' => 'Print job not found']);
        return;
    }

    echo json_encode([
        'success' => true,
        'job' => $result['data'][0]
    ]);
}
